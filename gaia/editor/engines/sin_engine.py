"""SIN Node Editor engine backend for GAIA audio projects."""

from __future__ import annotations

import copy
import math
from pathlib import Path
import re
from typing import Any
import uuid

from ermes.py.compiler import compute_auto_layout_positions
from ermes.py.snapshot import SNAPSHOT_FORMAT, validate_snapshot
import soundfile as sf
from sqlalchemy.orm import Session

from ... import crud, graph_builder, media_editor, models, project_manifest, project_service, reference_service
from ..base import EditorEngine

AUDIO_TYPES = frozenset({"audio", "track", "sample"})


def empty_sin_graph(bpm: float = 120.0) -> dict[str, Any]:
    """Return a valid master-only sin-graph for an empty SIN project."""
    return {
        "format": "sin-graph",
        "version": 1,
        "settings": {
            "bpm": float(bpm),
            "total_bars": "auto",
            "output": {
                "export_directory": "files/derived",
                "format": "wav",
                "normalize": False,
                "target_peak_db": -1.0,
            },
        },
        "output": "master",
        "nodes": [
            {
                "id": "master",
                "type": "track",
                "role": "master",
                "properties": {
                    "node_name": "Master Output",
                    "total_bars": "auto",
                    "chain": [],
                },
            }
        ],
        "connections": [],
    }


def _project_audio_items(db: Session, project: models.ProjectItem) -> list[models.Item]:
    """Collect distinct audio assets attached to a project via references or children."""
    items: list[models.Item] = []
    seen: set[int] = set()
    for reference in reference_service.list_references(db, project.id):
        item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
        if item and item.type in AUDIO_TYPES and item.id not in seen:
            items.append(item)
            seen.add(item.id)
    for child in sorted(project.children or [], key=lambda value: value.absolute_path.casefold()):
        if child.type in AUDIO_TYPES and child.id not in seen:
            items.append(child)
            seen.add(child.id)
    return items


def _project_multitrack_items(db: Session, project: models.ProjectItem) -> list[models.MultitrackItem]:
    """Collect distinct multitrack / Zoom H4 folders attached to a project."""
    mts: list[models.MultitrackItem] = []
    seen: set[int] = set()
    for reference in reference_service.list_references(db, project.id):
        item = db.query(models.Item).filter(models.Item.id == reference.to_item_id).first()
        if isinstance(item, models.MultitrackItem) and item.id not in seen:
            mts.append(item)
            seen.add(item.id)
    for child in sorted(project.children or [], key=lambda value: value.absolute_path.casefold()):
        if isinstance(child, models.MultitrackItem) and child.id not in seen:
            mts.append(child)
            seen.add(child.id)
    return mts


def _extract_layers_and_assets(
    db: Session,
    project: models.ProjectItem,
    graph: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    nodes = graph.get("nodes") or []
    connections = graph.get("connections") or []
    node_by_id = {n.get("id"): n for n in nodes if isinstance(n, dict) and n.get("id")}
    downstream: dict[str, str] = {}
    for conn in connections:
        if isinstance(conn, dict) and conn.get("from") and conn.get("to"):
            downstream[str(conn["from"])] = str(conn["to"])

    project_root = Path(project.absolute_path).resolve()
    layers: list[dict[str, Any]] = []
    graph_item_ids: set[int] = set()

    for node in nodes:
        if not isinstance(node, dict) or node.get("type") != "sample":
            continue
        src_id = str(node.get("id") or "")
        props = dict(node.get("properties") or {})
        asset_ref = props.get("asset_ref")
        if asset_ref is None and src_id.startswith("src-") and src_id[4:].isdigit():
            asset_ref = int(src_id[4:])

        item = crud.get_item(db, int(asset_ref)) if asset_ref is not None else None
        if isinstance(item, models.FolderItem):
            # Ignore invalid folder references if any legacy manifest still carried one
            continue

        resolved_path: Path | None = None
        if item and Path(item.absolute_path).is_file():
            resolved_path = Path(item.absolute_path).resolve()
        elif props.get("filepath"):
            cand = Path(str(props["filepath"]))
            if not cand.is_absolute():
                cand = (project_root / cand).resolve()
            if cand.is_file():
                resolved_path = cand

        frames = None
        sample_rate = None
        channels = None
        duration_seconds = None
        if resolved_path is not None:
            try:
                info = sf.info(str(resolved_path))
                frames = int(info.frames)
                sample_rate = int(info.samplerate)
                channels = int(info.channels)
                duration_seconds = float(info.duration)
            except Exception:
                pass

        ch_id = downstream.get(src_id)
        if not ch_id and src_id.startswith("src-"):
            cand_ch = f"ch-{src_id[4:]}"
            if cand_ch in node_by_id:
                ch_id = cand_ch
        ch_node = node_by_id.get(ch_id) if ch_id else None
        grp_id = downstream.get(ch_id) if ch_id else None
        if grp_id and not grp_id.startswith("grp-"):
            grp_id = None

        pre_gain_db = 0.0
        volume = 1.0
        muted = False
        chain = list((ch_node or {}).get("properties", {}).get("chain") or [])
        for mod in chain:
            if not isinstance(mod, dict):
                continue
            mid = mod.get("id")
            params = mod.get("params") or {}
            if mid == "pre":
                g = float(params.get("gain", 1.0) or 1.0)
                pre_gain_db = -60.0 if g <= 1e-4 else round(20.0 * math.log10(g), 2)
            elif mid == "fader":
                volume = max(0.0, min(1.0, float(params.get("gain", 1.0) if params.get("gain") is not None else 1.0)))
            elif mid == "mute":
                muted = bool(mod.get("enabled", False))

        item_id = item.id if item else (int(asset_ref) if asset_ref is not None else None)
        if item_id is not None:
            graph_item_ids.add(int(item_id))

        is_mixdown = bool(item and (item.attributes or {}).get("profile_role") == "mixdown")
        layers.append({
            "src_node_id": src_id,
            "ch_node_id": ch_id,
            "group_node_id": grp_id,
            "item_id": item_id,
            "label": props.get("node_name") or (getattr(item, "title", None) if item else None) or (resolved_path.name if resolved_path else src_id),
            "filename": resolved_path.name if resolved_path else Path(str(props.get("filepath") or src_id)).name,
            "filepath": props.get("filepath"),
            "waveform_url": f"/items/{item_id}/waveform" if item_id is not None else None,
            "stream_url": f"/items/{item_id}/stream" if item_id is not None else None,
            "frames": frames,
            "sample_rate": sample_rate,
            "channels": channels,
            "duration_seconds": duration_seconds,
            "crop_start": max(0.0, min(1.0, float(props.get("crop_start", 0.0) or 0.0))),
            "crop_end": max(0.0, min(1.0, float(props.get("crop_end", 1.0) if props.get("crop_end") is not None else 1.0))),
            "pre_gain_db": pre_gain_db,
            "volume": volume,
            "muted": muted,
            "is_mixdown": is_mixdown,
        })

    project_assets: list[dict[str, Any]] = []
    seen_assets: set[int] = set()
    for mt in _project_multitrack_items(db, project):
        stems = media_editor._multitrack_layers(mt)
        stem_ids = {s.id for s in stems}
        in_graph = bool(stem_ids) and stem_ids.issubset(graph_item_ids)
        project_assets.append({
            "id": mt.id,
            "label": getattr(mt, "title", None) or Path(mt.absolute_path).name,
            "type": mt.type,
            "is_multitrack": True,
            "stem_count": len(stems),
            "in_graph": in_graph,
        })
        seen_assets.add(mt.id)
    for item in _project_audio_items(db, project):
        if item.id in seen_assets:
            continue
        project_assets.append({
            "id": item.id,
            "label": getattr(item, "title", None) or Path(item.absolute_path).name,
            "type": item.type,
            "is_multitrack": False,
            "stem_count": 0,
            "in_graph": item.id in graph_item_ids,
        })
        seen_assets.add(item.id)

    return layers, project_assets


def _item_total_frames_and_duration(item: models.Item) -> tuple[int | None, float | None]:
    try:
        info = sf.info(str(Path(item.absolute_path).resolve()))
        return int(info.frames), float(info.duration)
    except Exception:
        return None, None


def _resolve_target_node_id(target_id: str | None) -> tuple[int | None, str | None]:
    if not target_id:
        return None, None
    match = re.fullmatch(r"(?:root|item|stem):(?P<item_id>\d+)", str(target_id).strip())
    if not match:
        return None, None
    item_id = int(match.group("item_id"))
    return item_id, f"src-{item_id}"


class SinEditorEngine(EditorEngine):
    engine_id = "sin"

    def default_session_data(self, db: Session, project: models.ProjectItem) -> dict[str, Any]:
        multitracks = _project_multitrack_items(db, project)
        audio_items = _project_audio_items(db, project)
        if multitracks:
            graph = graph_builder._build_graph_from_items([*multitracks, *audio_items], project=project)
        elif audio_items:
            graph = graph_builder._build_graph_from_items(audio_items, project=project)
        else:
            graph = empty_sin_graph()
        return {
            "graph": graph,
            "workspace": None,
            "snapshots": [],
            "active_snapshot_id": None,
        }

    def reset_project_graph(self, db: Session, project: models.ProjectItem) -> dict[str, Any]:
        """Reset a SIN project's manifest & session to a clean start point.

        Multitrack projects are auto-configured as multitrack SIN graphs (stems -> group -> master,
        Zoom mixdowns muted). Single/loose projects reset to an empty master-only SIN graph so
        wrongly generated legacy graphs do not linger.
        """
        multitracks = _project_multitrack_items(db, project)
        if multitracks:
            graph = graph_builder._build_graph_from_items(multitracks, project=project)
        else:
            graph = empty_sin_graph()

        session_envelope = {
            "engine": self.engine_id,
            "schema_version": 1,
            "data": {
                "graph": graph,
                "workspace": None,
                "snapshots": [],
                "active_snapshot_id": None,
            },
        }
        doc = project_manifest.read_project_manifest(project)
        for stale_key in ("editor", "edits", "checkpoints"):
            doc.pop(stale_key, None)
        doc["version"] = 3
        doc["schema"] = "gaia-project-state"
        doc["project_kind"] = getattr(project, "project_kind", None) or "audio"
        doc["editor_engine"] = self.engine_id
        doc["session"] = session_envelope
        doc["graph"] = graph
        doc["snapshots"] = []
        doc["view"] = {}
        project_manifest.write_project_manifest(project, doc)
        return session_envelope

    def build_session_from_simple_media(
        self,
        db: Session,
        project: models.ProjectItem,
        simple_data: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Translate an ephemeral simple_media edit into a canonical sin-graph + sin-snapshots."""
        simple_data = dict(simple_data or {})
        raw_targets = simple_data.get("targets")
        target_entries: list[dict[str, Any]] = []
        if isinstance(raw_targets, dict) and raw_targets:
            for tid, entry in raw_targets.items():
                if isinstance(entry, dict):
                    copied = dict(entry)
                    copied.setdefault("target_id", str(tid))
                    target_entries.append(copied)
        elif (
            simple_data.get("item_id") is not None
            or simple_data.get("source_item_id") is not None
            or simple_data.get("target_id") is not None
        ):
            target_entries.append(simple_data)

        item_ids: list[int] = []
        entry_by_item_id: dict[int, dict[str, Any]] = {}
        for entry in target_entries:
            raw_id = entry.get("item_id") if entry.get("item_id") is not None else entry.get("source_item_id")
            if raw_id is None and isinstance(entry.get("target_id"), str):
                parsed_id, _ = _resolve_target_node_id(entry["target_id"])
                raw_id = parsed_id
            if raw_id is None:
                continue
            item_id = int(raw_id)
            if item_id not in entry_by_item_id:
                item_ids.append(item_id)
                entry_by_item_id[item_id] = entry

        items: list[models.Item] = []
        for item_id in item_ids:
            item = crud.get_item(db, item_id)
            if item and (item.type in AUDIO_TYPES or isinstance(item, models.MultitrackItem)):
                items.append(item)

        if not items:
            items = [*_project_multitrack_items(db, project), *_project_audio_items(db, project)]
        if not items:
            return self.default_session_data(db, project)

        graph = graph_builder._build_graph_from_items(items, project=project)
        snapshots: list[dict[str, Any]] = []
        node_by_id = {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}

        for item in items:
            entry = entry_by_item_id.get(item.id)
            if not entry:
                continue

            if entry.get("normalize"):
                graph.setdefault("settings", {})["output"] = {
                    "normalize": True,
                    "target_peak_db": float(entry.get("target_peak_db", -1.0)),
                }

            if isinstance(item, models.MultitrackItem):
                stems = media_editor._multitrack_layers(item)
                if not stems:
                    continue

                stem_meta: list[tuple[models.Item, int | None, float | None, int]] = []
                for stem in stems:
                    s_frames, s_sec = _item_total_frames_and_duration(stem)
                    s_sr = int(round(s_frames / s_sec)) if (s_frames and s_sec and s_sec > 0) else 44100
                    stem_meta.append((stem, s_frames, s_sec, s_sr))

                common_sr = stem_meta[0][3] if stem_meta else 44100
                valid_secs = [s_sec for _, _, s_sec, _ in stem_meta if s_sec and s_sec > 0]
                common_sec = min(valid_secs) if valid_secs else None

                main_start_sec = entry.get("main_start_sec")
                if main_start_sec is None and entry.get("main_start_frame") is not None and common_sr > 0:
                    main_start_sec = float(entry["main_start_frame"]) / float(common_sr)
                main_end_sec = entry.get("main_end_sec")
                if main_end_sec is None and entry.get("main_end_frame") is not None and common_sr > 0:
                    main_end_sec = float(entry["main_end_frame"]) / float(common_sr)

                raw_layers = entry.get("layers") if isinstance(entry.get("layers"), list) else []
                layer_by_id: dict[int, dict[str, Any]] = {
                    int(l["item_id"]): l
                    for l in raw_layers
                    if isinstance(l, dict) and l.get("item_id") is not None
                }
                any_solo = any(bool(l.get("solo")) for l in layer_by_id.values())
                default_muted_ids = graph_builder._default_muted_ids_for_multitrack(stems)

                global_pre_db = float(entry.get("pre_gain_db") or 0.0)
                global_vol = max(0.0, min(1.0, float(entry.get("volume", 1.0) if entry.get("volume") is not None else 1.0)))
                grp_node = node_by_id.get(f"grp-{item.id}")

                for stem, s_frames, s_sec, _s_sr in stem_meta:
                    start_ratio = 0.0
                    end_ratio = 1.0
                    ref_sec = s_sec or common_sec
                    if ref_sec and ref_sec > 0:
                        if main_start_sec is not None:
                            start_ratio = max(0.0, min(1.0, float(main_start_sec) / ref_sec))
                        if main_end_sec is not None:
                            end_ratio = max(start_ratio, min(1.0, float(main_end_sec) / ref_sec))

                    src_node = node_by_id.get(f"src-{stem.id}")
                    if src_node:
                        src_props = src_node.setdefault("properties", {})
                        src_props["crop_start"] = round(start_ratio, 6)
                        src_props["crop_end"] = round(end_ratio, 6)

                    l_cfg = layer_by_id.get(stem.id)
                    l_pre_db = float(l_cfg.get("pre_gain_db") or 0.0) if l_cfg else 0.0
                    l_vol = max(
                        0.0,
                        min(1.0, float(l_cfg.get("volume", 1.0) if (l_cfg and l_cfg.get("volume") is not None) else 1.0)),
                    )
                    if any_solo:
                        l_muted = not bool(l_cfg and l_cfg.get("solo"))
                    elif l_cfg is not None and "muted" in l_cfg:
                        l_muted = bool(l_cfg["muted"])
                    else:
                        l_muted = stem.id in default_muted_ids

                    if grp_node is None:
                        l_pre_db += global_pre_db
                        l_vol *= global_vol

                    ch_node = node_by_id.get(f"ch-{stem.id}")
                    if ch_node:
                        ch_node.setdefault("properties", {})["chain"] = graph_builder.default_channel_chain(
                            volume=l_vol,
                            pre_gain=10.0 ** (l_pre_db / 20.0),
                            muted=l_muted,
                        )

                if grp_node is not None and (abs(global_pre_db) > 1e-4 or abs(global_vol - 1.0) > 1e-4):
                    grp_node.setdefault("properties", {})["chain"] = graph_builder.default_channel_chain(
                        volume=global_vol,
                        pre_gain=10.0 ** (global_pre_db / 20.0),
                        muted=False,
                    )

                cuts = entry.get("cuts") if isinstance(entry.get("cuts"), list) else entry.get("segments")
                if isinstance(cuts, list):
                    for idx, cut in enumerate(cuts, start=1):
                        if not isinstance(cut, dict):
                            continue
                        c_start_sec = cut.get("start_sec")
                        if c_start_sec is None and cut.get("start_frame") is not None and common_sr > 0:
                            c_start_sec = float(cut["start_frame"]) / float(common_sr)
                        c_end_sec = cut.get("end_sec")
                        if c_end_sec is None and cut.get("end_frame") is not None and common_sr > 0:
                            c_end_sec = float(cut["end_frame"]) / float(common_sr)

                        overrides: dict[str, dict[str, float]] = {}
                        for stem, _s_frames, s_sec, _s_sr in stem_meta:
                            ref_sec = s_sec or common_sec
                            c_s0 = 0.0
                            c_s1 = 1.0
                            if ref_sec and ref_sec > 0:
                                if c_start_sec is not None:
                                    c_s0 = max(0.0, min(1.0, float(c_start_sec) / ref_sec))
                                if c_end_sec is not None:
                                    c_s1 = max(c_s0, min(1.0, float(c_end_sec) / ref_sec))
                            overrides[f"src-{stem.id}"] = {
                                "crop_start": round(c_s0, 6),
                                "crop_end": round(c_s1, 6),
                            }

                        cut_id = str(cut.get("id") or f"cut-{idx}-{uuid.uuid4().hex[:6]}")
                        snapshots.append({
                            "format": SNAPSHOT_FORMAT,
                            "version": 1,
                            "id": cut_id,
                            "label": str(cut.get("label") or f"Cut {idx}"),
                            "root": "master",
                            "overrides": overrides,
                            "meta": {"source_engine": "simple_media"},
                        })
                continue

            total_frames, total_sec = _item_total_frames_and_duration(item)

            start_ratio = 0.0
            end_ratio = 1.0
            if total_frames and total_frames > 0 and entry.get("main_start_frame") is not None:
                start_ratio = max(0.0, min(1.0, float(entry["main_start_frame"]) / total_frames))
            elif total_sec and total_sec > 0 and entry.get("main_start_sec") is not None:
                start_ratio = max(0.0, min(1.0, float(entry["main_start_sec"]) / total_sec))

            if total_frames and total_frames > 0 and entry.get("main_end_frame") is not None:
                end_ratio = max(start_ratio, min(1.0, float(entry["main_end_frame"]) / total_frames))
            elif total_sec and total_sec > 0 and entry.get("main_end_sec") is not None:
                end_ratio = max(start_ratio, min(1.0, float(entry["main_end_sec"]) / total_sec))

            src_node = node_by_id.get(f"src-{item.id}")
            if src_node:
                src_props = src_node.setdefault("properties", {})
                src_props["crop_start"] = round(start_ratio, 6)
                src_props["crop_end"] = round(end_ratio, 6)

            pre_db = float(entry.get("pre_gain_db") or 0.0)
            pre_linear = 10.0 ** (pre_db / 20.0)
            volume = float(entry.get("volume", 1.0))
            volume = max(0.0, min(1.0, volume))
            ch_node = node_by_id.get(f"ch-{item.id}")
            if ch_node:
                ch_node.setdefault("properties", {})["chain"] = graph_builder.default_channel_chain(
                    volume=volume,
                    pre_gain=pre_linear,
                    muted=False,
                )

            cuts = entry.get("cuts") if isinstance(entry.get("cuts"), list) else entry.get("segments")
            if isinstance(cuts, list):
                for idx, cut in enumerate(cuts, start=1):
                    if not isinstance(cut, dict):
                        continue
                    c_start_ratio = 0.0
                    c_end_ratio = 1.0
                    if total_frames and total_frames > 0 and cut.get("start_frame") is not None:
                        c_start_ratio = max(0.0, min(1.0, float(cut["start_frame"]) / total_frames))
                    elif total_sec and total_sec > 0 and cut.get("start_sec") is not None:
                        c_start_ratio = max(0.0, min(1.0, float(cut["start_sec"]) / total_sec))

                    if total_frames and total_frames > 0 and cut.get("end_frame") is not None:
                        c_end_ratio = max(c_start_ratio, min(1.0, float(cut["end_frame"]) / total_frames))
                    elif total_sec and total_sec > 0 and cut.get("end_sec") is not None:
                        c_end_ratio = max(c_start_ratio, min(1.0, float(cut["end_sec"]) / total_sec))

                    cut_id = str(cut.get("id") or f"cut-{idx}-{uuid.uuid4().hex[:6]}")
                    snapshots.append({
                        "format": SNAPSHOT_FORMAT,
                        "version": 1,
                        "id": cut_id,
                        "label": str(cut.get("label") or f"Cut {idx}"),
                        "root": "master",
                        "overrides": {
                            f"src-{item.id}": {
                                "crop_start": round(c_start_ratio, 6),
                                "crop_end": round(c_end_ratio, 6),
                            }
                        },
                        "meta": {"source_engine": "simple_media"},
                    })

        return {
            "graph": graph,
            "workspace": None,
            "snapshots": snapshots,
            "active_snapshot_id": None,
        }

    def build_project_session(
        self,
        db: Session,
        project: models.ProjectItem,
        target_id: str | None = None,
    ) -> dict[str, Any]:
        stored = project_manifest.read_project_session(project)
        if isinstance(stored, dict) and stored.get("engine") == self.engine_id:
            data = copy.deepcopy(stored.get("data") or {})
        else:
            data = self.default_session_data(db, project)

        graph = data.get("graph")
        if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
            graph = empty_sin_graph()
        data["graph"] = graph
        data.setdefault("workspace", None)
        data.setdefault("snapshots", [])
        data.setdefault("active_snapshot_id", None)

        positions = compute_auto_layout_positions(graph)
        control_map = graph_builder.get_control_map(graph)
        layers, project_assets = _extract_layers_and_assets(db, project, graph)
        focus_item_id, focus_node_id = _resolve_target_node_id(target_id)
        if focus_node_id and not any(n.get("id") == focus_node_id for n in graph.get("nodes", [])):
            focus_node_id = None

        audio_items = _project_audio_items(db, project)
        targets = [
            {
                "id": f"item:{item.id}",
                "item_id": item.id,
                "label": getattr(item, "title", None) or Path(item.absolute_path).name,
                "type": item.type,
                "media_kind": "audio",
            }
            for item in audio_items
        ]
        node_count = len([n for n in graph.get("nodes", []) if n.get("id") != "master"])
        has_workspace = bool(isinstance(data.get("workspace"), dict) and data["workspace"].get("graph"))
        is_multitrack = any(str(n.get("id", "")).startswith("grp-") for n in graph.get("nodes", [])) or len(layers) > 1

        return {
            "session_data": data,
            "positions": positions,
            "control_map": control_map,
            "layers": layers,
            "project_assets": project_assets,
            "targets": targets,
            "focus_item_id": focus_item_id,
            "focus_node_id": focus_node_id,
            "has_workspace": has_workspace,
            "is_multitrack": is_multitrack,
            "is_empty": len(layers) == 0 and node_count == 0 and not has_workspace,
            "capabilities": {
                "graph": True,
                "timeline": True,
                "mixer": True,
                "cut": True,
                "open_in_sin": True,
                "snapshots": True,
                "checkpoints": True,
                "export": True,
            },
        }

    def validate_and_merge_session(
        self,
        db: Session,
        project: models.ProjectItem,
        incoming_data: dict[str, Any],
        existing_data: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(incoming_data, dict):
            raise ValueError("SIN session data must be a JSON object")

        merged = copy.deepcopy(existing_data or {})
        if "graph" in incoming_data and incoming_data["graph"] is not None:
            graph = incoming_data["graph"]
            if not isinstance(graph, dict) or graph.get("format") != "sin-graph":
                raise ValueError("SIN session graph must use format 'sin-graph'")
            merged["graph"] = graph
        elif not isinstance(merged.get("graph"), dict):
            merged["graph"] = empty_sin_graph()

        if "workspace" in incoming_data:
            workspace = incoming_data["workspace"]
            if workspace is not None:
                if not isinstance(workspace, dict) or not isinstance(workspace.get("graph"), dict):
                    raise ValueError("SIN workspace payload must contain a serialized LiteGraph 'graph'")
            merged["workspace"] = workspace
        else:
            merged.setdefault("workspace", None)

        if "snapshots" in incoming_data and incoming_data["snapshots"] is not None:
            snapshots = incoming_data["snapshots"]
            if not isinstance(snapshots, list):
                raise ValueError("Snapshots must be a list")
            for snap in snapshots:
                if not isinstance(snap, dict) or not snap.get("id"):
                    raise ValueError("Every SIN snapshot must be an object with an 'id'")
                if snap.get("format") == SNAPSHOT_FORMAT:
                    ok, errors = validate_snapshot(merged["graph"], snap)
                    if not ok:
                        raise ValueError("; ".join(errors))
            merged["snapshots"] = snapshots
        else:
            merged.setdefault("snapshots", [])

        if "active_snapshot_id" in incoming_data:
            merged["active_snapshot_id"] = incoming_data["active_snapshot_id"]
        else:
            merged.setdefault("active_snapshot_id", None)

        return merged

    def save_snapshot(
        self,
        db: Session,
        project: models.ProjectItem,
        snapshot: dict[str, Any],
        *,
        make_active: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(snapshot, dict) or not snapshot.get("id"):
            raise ValueError("Snapshot must have an 'id'")
        stored = project_manifest.read_project_session(project)
        existing_data = dict((stored or {}).get("data") or self.default_session_data(db, project))
        snapshots = list(existing_data.get("snapshots") or [])
        snap_copy = dict(snapshot)
        snap_copy.setdefault("format", SNAPSHOT_FORMAT)
        snap_copy.setdefault("version", 1)
        idx = next((i for i, s in enumerate(snapshots) if isinstance(s, dict) and s.get("id") == snap_copy["id"]), -1)
        if idx >= 0:
            snapshots[idx] = snap_copy
        else:
            snapshots.append(snap_copy)
        existing_data["snapshots"] = snapshots
        if make_active:
            existing_data["active_snapshot_id"] = snap_copy["id"]
        merged = self.validate_and_merge_session(db, project, existing_data, existing_data)
        project_manifest.write_project_session(
            db,
            project.id,
            {"engine": self.engine_id, "schema_version": 1, "data": merged},
        )
        return merged

    def delete_snapshot(
        self,
        db: Session,
        project: models.ProjectItem,
        snapshot_id: str,
    ) -> dict[str, Any]:
        stored = project_manifest.read_project_session(project)
        existing_data = dict((stored or {}).get("data") or self.default_session_data(db, project))
        snapshots = [
            s for s in (existing_data.get("snapshots") or [])
            if isinstance(s, dict) and s.get("id") != snapshot_id
        ]
        existing_data["snapshots"] = snapshots
        if existing_data.get("active_snapshot_id") == snapshot_id:
            existing_data["active_snapshot_id"] = None
        merged = self.validate_and_merge_session(db, project, existing_data, existing_data)
        project_manifest.write_project_session(
            db,
            project.id,
            {"engine": self.engine_id, "schema_version": 1, "data": merged},
        )
        return merged


sin_engine = SinEditorEngine()


def reset_all_projects_to_clean_start(db: Session) -> dict[str, int]:
    """Normalize all audio projects in DB to clean SIN graphs (multitrack auto-setup or empty master)."""
    projects = db.query(models.ProjectItem).filter(models.ProjectItem.type == "project").all()
    reset_count = 0
    multitrack_count = 0
    for proj in projects:
        if getattr(proj, "project_kind", "audio") != "audio":
            continue
        proj.editor_engine = "sin"
        db.add(proj)
        db.flush()
        env = sin_engine.reset_project_graph(db, proj)
        nodes = ((env.get("data") or {}).get("graph") or {}).get("nodes") or []
        if len([n for n in nodes if n.get("id") != "master"]) > 0:
            multitrack_count += 1
        reset_count += 1
    db.commit()
    return {"projects_reset": reset_count, "multitracks_configured": multitrack_count}
