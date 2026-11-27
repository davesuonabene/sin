"""Pure Python data packer compiling GAIA canonical `sin-graph` documents and SIN
`AudioNodeModel` workspaces into flat `SinRenderPlan` structures for `libsin_dsp`.

Responsibilities:
- Python owns graph resolution, GAIA path resolution, ERMES pseudolanguage (`slot_language.py`),
  3-tier dirty caching (`DagNodeCache`), and Tier-2 offline cooking (Rubber Band R3).
- C++ (`libsin_dsp`) owns all file decoding, multi-GB disk streaming, resampling (48kHz default /
  any SR), cropping, looping, fades, voice mixing, bus gain/pan/mute/solo, and device/offline output.
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from core.render_plan import (
    PROCESSOR_TYPE_TO_ID,
    SIN_CLIP_LIVE_CROP_BOUND,
    SIN_CLIP_LIVE_RATE_BOUND,
    SIN_CLIP_LOOP_SOURCE,
    SIN_CLIP_TILE_TIME_STRETCHED,
    SIN_DEFAULT_SAMPLE_RATE,
    SIN_PROC_NONE,
    BusSpec,
    ChainStageSpec,
    ClipSpec,
    SinRenderPlan,
    SourceSpec,
    pack_processor_params,
)
from core.system import System
from ermes.py.slot_language import (
    is_field_operator_expression,
    resolve_pool_item_by_query,
)
from core.dsp import load_sample, process_sample_transform
from core.dag_cache import GLOBAL_DAG_CACHE
from ermes.py.snapshot import apply_snapshot
from ermes.py.compiler import (
    compile_canonical_graph_to_audio_node_model,
    compile_workspace_to_audio_node_model,
)


def _linear_to_db(gain: float) -> float:
    if gain <= 1e-6:
        return -120.0
    return float(20.0 * math.log10(gain))


def _is_fixed_pre_gain(mod: Dict[str, Any]) -> bool:
    mod_id = str(mod.get("id") or "").strip().lower()
    mod_name = str(mod.get("name") or "").strip().lower()
    return mod_id == "pre" or mod_id.startswith("pre_gain") or (bool(mod.get("fixed")) and mod_name == "pre gain")


def _is_fixed_post_gain(mod: Dict[str, Any]) -> bool:
    mod_id = str(mod.get("id") or "").strip().lower()
    mod_name = str(mod.get("name") or "").strip().lower()
    return mod_id == "post" or mod_id.startswith("post_gain") or (bool(mod.get("fixed")) and mod_name == "post gain")


def _chain_to_bus_gains(chain: Optional[List[Dict[str, Any]]], top_gain_db: Optional[float] = None) -> Tuple[float, float, float, bool]:
    """Extract (pre_gain_db, volume_linear, post_gain_db, muted) from an ERMES FX chain."""
    pre_db = 0.0
    volume = 1.0
    post_db = 0.0
    muted = False

    modules = chain or []
    if not modules and top_gain_db is not None:
        try:
            g_db = float(top_gain_db)
            post_db = -120.0 if g_db <= -35.9 else g_db
        except (TypeError, ValueError):
            pass
        return pre_db, volume, post_db, muted

    for mod in modules:
        if not isinstance(mod, dict):
            continue
        mod_id = str(mod.get("id") or "").lower()
        mod_type = str(mod.get("type") or "").lower()
        enabled = bool(mod.get("enabled", True))
        params = mod.get("params") or {}

        if mod_id == "mute":
            if enabled:
                muted = True
            continue
        if not enabled or mod_type != "gain":
            continue

        if _is_fixed_pre_gain(mod):
            if params.get("gain_db") is not None:
                db = float(params["gain_db"])
                pre_db += (-120.0 if db <= -35.9 else db)
            elif params.get("gain") is not None:
                pre_db += _linear_to_db(float(params["gain"]))
        elif mod_id == "fader":
            if params.get("gain") is not None:
                volume *= max(0.0, float(params["gain"]))
            elif params.get("gain_db") is not None:
                db = float(params["gain_db"])
                volume *= (0.0 if db <= -35.9 else float(10.0 ** (db / 20.0)))
        elif _is_fixed_post_gain(mod) or bool(mod.get("fixed")):
            if params.get("gain_db") is not None:
                db = float(params["gain_db"])
                post_db += (-120.0 if db <= -35.9 else db)
            elif params.get("gain") is not None:
                post_db += _linear_to_db(float(params["gain"]))

    return pre_db, volume, post_db, muted


def _pack_chain_stages(bus_id: int, chain: Optional[List[Dict[str, Any]]]) -> List[ChainStageSpec]:
    """Emit ordered `ChainStageSpec` entries for user FX modules (excluding fixed Pre/Post Gain endpoints)."""
    if not chain:
        return []
    stages: List[ChainStageSpec] = []
    stage_idx = 0
    for mod in chain:
        if not isinstance(mod, dict):
            continue
        mod_id = str(mod.get("id") or "").lower()
        mod_type = str(mod.get("type") or "").strip().lower()
        if mod_id in ("mute", "fader"):
            continue
        if mod_type == "gain" and (_is_fixed_pre_gain(mod) or _is_fixed_post_gain(mod) or bool(mod.get("fixed"))):
            continue
        proc_id = PROCESSOR_TYPE_TO_ID.get(mod_type, SIN_PROC_NONE)
        if proc_id == SIN_PROC_NONE:
            continue
        params_list = pack_processor_params(mod_type, mod.get("params") or {})
        stages.append(ChainStageSpec(
            bus_id=int(bus_id),
            stage_index=stage_idx,
            processor_type=int(proc_id),
            enabled=bool(mod.get("enabled", True)),
            params=params_list,
        ))
        stage_idx += 1
    return stages


def _resolve_relative_filepath(raw_path: Optional[str], project_root: Optional[Path]) -> Optional[str]:
    if not raw_path:
        return None
    raw_str = str(raw_path)
    if os.path.isabs(raw_str):
        return raw_str
    if project_root:
        root_path = Path(project_root).resolve()
        cand = (root_path / raw_str).resolve()
        if cand.is_file():
            return str(cand)
        cand_in_files = (root_path / "files" / Path(raw_str).name).resolve()
        if cand_in_files.is_file():
            return str(cand_in_files)
    alt = os.path.join("assets", raw_str)
    if os.path.exists(alt):
        return os.path.abspath(alt)
    return raw_str


def _is_auto_bars(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("", "auto", "free", "none"):
            return True
        try:
            return float(s) <= 0.0
        except ValueError:
            return True
    try:
        return float(value) <= 0.0
    except (TypeError, ValueError):
        return True


SINGLE_PASS_STRETCH_MAX_SEC = 16.0
MAX_OFFLINE_STRETCH_SEC = 60.0  # retained alias for compatibility


def _is_repeat_enabled(props: Dict[str, Any]) -> bool:
    raw_repeat = props.get("repeat")
    if raw_repeat is not None:
        return bool(raw_repeat)
    return str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower() == "loop"


def _effective_stretch_params(props: Dict[str, Any], target_bpm: float) -> Tuple[bool, float, float, str]:
    """Compute `(is_warp, tempo_rate, semitones, algorithm)` matching `core.dsp.process_sample_transform`."""
    raw_warp = props.get("warp")
    mode = str(props.get("stretch_mode") or "time_stretch").lower()
    if raw_warp is False:
        is_warp = False
    elif raw_warp is True:
        is_warp = True
    else:
        is_warp = mode not in ("off", "pitch_shift", "repitch", "varispeed")

    semis = float(props.get("transpose") or 0.0) + float(props.get("cents") or 0.0) / 100.0
    factor = float(props.get("stretch_factor") or 1.0)
    if factor <= 0.0:
        factor = 1.0
    algorithm = str(props.get("stretch_algorithm") or "rubberband")

    sample_type = str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower()
    allow_bpm_sync = (
        True if raw_warp is True
        else (False if raw_warp is False else (sample_type not in ("one_shot", "oneshot") and mode != "off"))
    )
    bpm_rate = 1.0
    orig_bpm = props.get("original_bpm")
    if allow_bpm_sync and orig_bpm is not None:
        try:
            orig = float(orig_bpm)
            tgt = float(target_bpm)
            if orig > 0.0 and tgt > 0.0 and abs(orig - tgt) > 1e-4:
                direct_rate = tgt / orig
                match_mode = str(props.get("key_match_mode") or "off").lower().strip()
                km_algo = str(props.get("key_match_algorithm") or "nearest").lower().strip()
                if match_mode not in ("follow", "lead") or km_algo in ("off", "direct") or abs(math.log2(direct_rate)) < 0.35:
                    bpm_rate = direct_rate
                else:
                    cands = [r for r in (direct_rate, direct_rate * 2.0, direct_rate * 0.5) if r > 0.0]
                    if km_algo in ("higher", "up"):
                        up = [r for r in cands if r >= 1.0]
                        bpm_rate = min(up, key=lambda r: abs(math.log2(r))) if up else max(cands)
                    elif km_algo in ("lower", "down"):
                        dn = [r for r in cands if r <= 1.0]
                        bpm_rate = min(dn, key=lambda r: abs(math.log2(r))) if dn else min(cands)
                    else:
                        bpm_rate = min(cands, key=lambda r: abs(math.log2(r)))
        except (TypeError, ValueError):
            pass

    tempo_rate = max(0.05, float(bpm_rate * factor))
    return is_warp, tempo_rate, semis, algorithm


def _needs_offline_stretch(props: Dict[str, Any], target_bpm: float) -> bool:
    is_warp, tempo_rate, semis, _algo = _effective_stretch_params(props, target_bpm)
    if not is_warp:
        return False
    return abs(semis) > 1e-4 or abs(tempo_rate - 1.0) > 1e-4


def _needs_offline_stretch_for_file(
    resolved_fp: Optional[str],
    props: Dict[str, Any],
    target_bpm: float,
    *,
    crop_start: float = 0.0,
    crop_end: float = 1.0,
) -> bool:
    """True when Rubber Band stretching is required (crop-aware or tiled)."""
    if not _needs_offline_stretch(props, target_bpm):
        return False
    return True


def _varispeed_rate(props: Dict[str, Any], target_bpm: float) -> float:
    raw_warp = props.get("warp")
    mode = str(props.get("stretch_mode") or "off").lower()
    if raw_warp is True:
        return 1.0
    if raw_warp is None and mode not in ("pitch_shift", "repitch", "varispeed"):
        return 1.0
    semis = float(props.get("transpose") or 0.0) + float(props.get("cents") or 0.0) / 100.0
    pitch_rate = 2.0 ** (semis / 12.0)
    factor = float(props.get("stretch_factor") or 1.0)
    if factor <= 0:
        factor = 1.0
    bpm_rate = 1.0
    if raw_warp is None:
        sample_type = str(props.get("sample_type") or props.get("sample_mode") or "one_shot").lower()
        orig_bpm = props.get("original_bpm")
        if sample_type not in ("one_shot", "oneshot") and orig_bpm is not None:
            try:
                if float(orig_bpm) > 0 and target_bpm > 0:
                    bpm_rate = float(target_bpm) / float(orig_bpm)
            except (TypeError, ValueError):
                pass
    return max(0.05, float(pitch_rate * factor * bpm_rate))


def _read_cropped_disk_slice(filepath: str, sr: int, crop_start: float, crop_end: float) -> np.ndarray:
    """Seek and decode ONLY `[crop_start .. crop_end]` from disk resampled to `sr` (zero full-file RAM)."""
    cs = max(0.0, min(1.0, float(crop_start)))
    ce = max(cs, min(1.0, float(crop_end)))
    if ce <= cs:
        return np.zeros((2, 0), dtype=np.float32)
    try:
        import soundfile as sf
        from scipy import signal as scipy_signal
        with sf.SoundFile(filepath, mode="r") as f:
            file_sr = int(f.samplerate or sr)
            total = int(len(f))
            if total <= 0 or file_sr <= 0:
                return np.zeros((2, 0), dtype=np.float32)
            s0 = max(0, min(total, int(math.floor(cs * total))))
            s1 = max(s0, min(total, int(math.ceil(ce * total))))
            if s1 <= s0:
                return np.zeros((2, 0), dtype=np.float32)
            f.seek(s0)
            raw = f.read(s1 - s0, dtype="float32", always_2d=True)
            if raw.size == 0:
                return np.zeros((2, 0), dtype=np.float32)
            audio = np.ascontiguousarray(raw.T, dtype=np.float32)
            if audio.shape[0] == 1:
                audio = np.repeat(audio, 2, axis=0)
            elif audio.shape[0] > 2:
                audio = audio[:2]
            if file_sr != int(sr):
                g = math.gcd(int(sr), file_sr)
                audio = scipy_signal.resample_poly(audio, int(sr) // g, file_sr // g, axis=-1).astype(np.float32, copy=False)
            return np.ascontiguousarray(audio, dtype=np.float32)
    except Exception:
        audio, _ = load_sample(filepath, target_sr=sr)
        if audio.ndim == 1:
            audio = np.stack([audio, audio], axis=0)
        total = int(audio.shape[-1])
        s0 = max(0, min(total, int(math.floor(cs * total))))
        s1 = max(s0, min(total, int(math.ceil(ce * total))))
        return np.ascontiguousarray(audio[:, s0:s1], dtype=np.float32)


def _cook_stretched_sample_chunked(
    filepath: str,
    props: Dict[str, Any],
    target_bpm: float,
    sr: int,
    *,
    crop_start: float = 0.0,
    crop_end: float = 1.0,
    fast_preview: bool = False,
) -> np.ndarray:
    """Chunked OLA Rubber Band cooker for long active slices (>16s) without full-file RAM spikes."""
    from core.stretching import (
        RubberBandUnavailableError,
        StretchAlgorithm,
        normalize_stretch_algorithm,
        stretch_with_rubberband,
    )
    import soundfile as sf
    from scipy import signal as scipy_signal

    _is_warp, tempo_rate, semis, algo_str = _effective_stretch_params(props, target_bpm)
    algo = normalize_stretch_algorithm(algo_str)
    finfo = _probe_file_info(filepath)
    if finfo is None:
        audio = _read_cropped_disk_slice(filepath, sr, crop_start, crop_end)
        return process_sample_transform(
            audio_data=audio,
            sr=sr,
            original_bpm=props.get("original_bpm"),
            target_bpm=target_bpm,
            transpose=float(props.get("transpose") or 0.0),
            cents=float(props.get("cents") or 0.0),
            stretch_mode=str(props.get("stretch_mode") or "time_stretch"),
            stretch_factor=float(props.get("stretch_factor") or 1.0),
            stretch_algorithm=algo_str,
            sample_type=str(props.get("sample_type") or "loop"),
            fast_preview=fast_preview,
            key_match_mode=str(props.get("key_match_mode") or "off"),
            key_match_algorithm=str(props.get("key_match_algorithm") or "nearest"),
            warp=props.get("warp"),
        )

    file_sr, file_frames, file_dur = finfo
    raw_total_sr = max(1, int(round(file_dur * sr)))
    cs = max(0.0, min(1.0, float(crop_start)))
    ce = max(cs, min(1.0, float(crop_end)))
    crop_src_s0 = int(math.floor(cs * raw_total_sr))
    crop_src_s1 = int(math.ceil(ce * raw_total_sr))
    crop_src_len = max(0, crop_src_s1 - crop_src_s0)
    if crop_src_len <= 0:
        return np.zeros((2, 0), dtype=np.float32)

    out_total = max(1, int(round(float(crop_src_len) / tempo_rate)))
    chunk_out_frames = int(round(SINGLE_PASS_STRETCH_MAX_SEC * sr))
    halo_src = int(round(0.75 * max(1.0, tempo_rate) * sr))
    pieces: List[np.ndarray] = []

    with sf.SoundFile(filepath, mode="r") as f:
        ratio = float(file_sr) / float(sr)
        for o0 in range(0, out_total, chunk_out_frames):
            o1 = min(out_total, o0 + chunk_out_frames)
            core_len = o1 - o0
            src_s0 = crop_src_s0 + int(round(float(o0) * tempo_rate))
            src_s1 = crop_src_s0 + int(round(float(o1) * tempo_rate))
            h0 = max(0, src_s0 - halo_src)
            h1 = min(raw_total_sr, src_s1 + halo_src)
            trim_left = max(0, int(round(float(src_s0 - h0) / tempo_rate)))

            f_s0 = max(0, min(file_frames, int(math.floor(h0 * ratio))))
            f_s1 = max(f_s0, min(file_frames, int(math.ceil(h1 * ratio)) + 16))
            f.seek(f_s0)
            raw = f.read(f_s1 - f_s0, dtype="float32", always_2d=True)
            chunk = np.ascontiguousarray(raw.T, dtype=np.float32) if raw.size > 0 else np.zeros((2, 0), dtype=np.float32)
            if chunk.shape[0] == 1:
                chunk = np.repeat(chunk, 2, axis=0)
            elif chunk.shape[0] > 2:
                chunk = chunk[:2]
            if file_sr != sr and chunk.shape[-1] > 0:
                g = math.gcd(int(sr), file_sr)
                chunk = scipy_signal.resample_poly(chunk, int(sr) // g, file_sr // g, axis=-1).astype(np.float32, copy=False)
            needed_in = max(1, h1 - h0)
            if chunk.shape[-1] < needed_in:
                chunk = np.concatenate([chunk, np.zeros((2, needed_in - chunk.shape[-1]), dtype=np.float32)], axis=-1)
            else:
                chunk = chunk[:, :needed_in]

            if algo is not StretchAlgorithm.LIBROSA:
                try:
                    st_chunk = stretch_with_rubberband(
                        chunk,
                        sr,
                        algorithm=algo,
                        tempo_rate=tempo_rate,
                        semitones=semis,
                        fast_engine=fast_preview,
                    )
                except RubberBandUnavailableError:
                    import librosa
                    st_chunk = chunk
                    if abs(semis) > 1e-4:
                        st_chunk = librosa.effects.pitch_shift(y=st_chunk, sr=sr, n_steps=semis)
                    if abs(tempo_rate - 1.0) > 1e-4:
                        st_chunk = librosa.effects.time_stretch(y=st_chunk, rate=tempo_rate)
            else:
                import librosa
                st_chunk = chunk
                if abs(semis) > 1e-4:
                    st_chunk = librosa.effects.pitch_shift(y=st_chunk, sr=sr, n_steps=semis)
                if abs(tempo_rate - 1.0) > 1e-4:
                    st_chunk = librosa.effects.time_stretch(y=st_chunk, rate=tempo_rate)

            if st_chunk.ndim == 1:
                st_chunk = np.stack([st_chunk, st_chunk], axis=0)
            core = np.ascontiguousarray(st_chunk[:, trim_left : trim_left + core_len], dtype=np.float32)
            if core.shape[-1] < core_len:
                core = np.concatenate([core, np.zeros((2, core_len - core.shape[-1]), dtype=np.float32)], axis=-1)
            pieces.append(core)

    return np.concatenate(pieces, axis=-1) if pieces else np.zeros((2, 0), dtype=np.float32)


def _cook_stretched_sample(
    filepath: str,
    props: Dict[str, Any],
    target_bpm: float,
    sr: int,
    *,
    crop_start: float = 0.0,
    crop_end: float = 1.0,
    fast_preview: bool = False,
) -> Tuple[np.ndarray, int]:
    """Tier-2 lazy Python cooker for crop-aware Rubber Band / librosa time-stretch, cached in DagNodeCache."""
    try:
        st = os.stat(filepath)
        file_sig = f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        file_sig = ""
    cs = max(0.0, min(1.0, float(crop_start)))
    ce = max(cs, min(1.0, float(crop_end)))
    cook_key = {
        "op": "tier2_cook_crop",
        "path": filepath,
        "sig": file_sig,
        "sr": sr,
        "crop_start": round(cs, 6),
        "crop_end": round(ce, 6),
        "target_bpm": round(float(target_bpm), 4),
        "original_bpm": props.get("original_bpm"),
        "transpose": float(props.get("transpose") or 0.0),
        "cents": float(props.get("cents") or 0.0),
        "warp": props.get("warp"),
        "stretch_mode": str(props.get("stretch_mode") or "time_stretch"),
        "stretch_factor": float(props.get("stretch_factor") or 1.0),
        "stretch_algorithm": str(props.get("stretch_algorithm") or "rubberband"),
        "sample_type": str(props.get("sample_type") or "loop"),
        "key_match_mode": str(props.get("key_match_mode") or "off"),
        "key_match_algorithm": str(props.get("key_match_algorithm") or "nearest"),
        "fast_preview": bool(fast_preview),
    }
    fp_hash = GLOBAL_DAG_CACHE.compute_fingerprint(cook_key)
    cache_node_id = f"cook:{fp_hash}"
    cached = GLOBAL_DAG_CACHE.get(cache_node_id, fp_hash)
    if cached is not None:
        return cached, int(fp_hash[:12], 16)

    finfo = _probe_file_info(filepath)
    active_span_sec = ((ce - cs) * finfo[2]) if finfo is not None else 0.0
    if finfo is not None and active_span_sec > SINGLE_PASS_STRETCH_MAX_SEC:
        cooked = _cook_stretched_sample_chunked(
            filepath,
            props,
            target_bpm,
            sr,
            crop_start=cs,
            crop_end=ce,
            fast_preview=fast_preview,
        )
    else:
        audio = _read_cropped_disk_slice(filepath, sr, cs, ce)
        cooked = process_sample_transform(
            audio_data=audio,
            sr=sr,
            original_bpm=props.get("original_bpm"),
            target_bpm=target_bpm,
            transpose=float(props.get("transpose") or 0.0),
            cents=float(props.get("cents") or 0.0),
            stretch_mode=str(props.get("stretch_mode") or "time_stretch"),
            stretch_factor=float(props.get("stretch_factor") or 1.0),
            stretch_algorithm=str(props.get("stretch_algorithm") or "rubberband"),
            sample_type=str(props.get("sample_type") or "loop"),
            fast_preview=fast_preview,
            key_match_mode=str(props.get("key_match_mode") or "off"),
            key_match_algorithm=str(props.get("key_match_algorithm") or "nearest"),
            warp=props.get("warp"),
        )
    GLOBAL_DAG_CACHE.store(cache_node_id, fp_hash, cooked)
    return cooked, int(fp_hash[:12], 16)


def pack_canonical_graph(
    base_graph: Dict[str, Any],
    snapshot: Optional[Dict[str, Any]] = None,
    transient_overrides: Optional[Dict[str, Any]] = None,
    root_id: Optional[str] = None,
    project_root: Optional[Path] = None,
    sample_rate: int = SIN_DEFAULT_SAMPLE_RATE,
    workspace: Optional[Dict[str, Any]] = None,
    solo_ids: Optional[List[str]] = None,
) -> SinRenderPlan:
    """Pack a GAIA canonical `sin-graph` (or attached SIN workspace) into a flat `SinRenderPlan`.

    Direct unstretched audio files (including 8 GB Zoom H4 multitracks) are registered strictly
    as file paths (`force_ram=False`) so libsin_dsp streams them directly from disk without
    loading gigabytes into Python RAM.
    """
    use_workspace = (
        isinstance(workspace, dict)
        and isinstance(workspace.get("graph"), dict)
        and bool(workspace["graph"].get("nodes"))
        and snapshot is None
        and not transient_overrides
    )
    if use_workspace:
        resolved_ws = copy.deepcopy(workspace)
        graph = resolved_ws.get("graph") if isinstance(resolved_ws.get("graph"), dict) else resolved_ws
        if project_root and isinstance(graph, dict):
            for node in graph.get("nodes", []):
                props = node.get("properties") if isinstance(node, dict) else None
                if isinstance(props, dict):
                    if props.get("filepath"):
                        props["filepath"] = _resolve_relative_filepath(props.get("filepath"), project_root)
                    for slot in props.get("slots") or []:
                        if isinstance(slot, dict) and slot.get("filepath"):
                            slot["filepath"] = _resolve_relative_filepath(slot.get("filepath"), project_root)
        model = compile_workspace_to_audio_node_model(resolved_ws)
        ws_extra = (resolved_ws.get("graph") or {}).get("extra") or {}
        bpm = float((ws_extra.get("global_parameters") or {}).get("bpm", 120.0))
        sys_obj = System(bpm=bpm, sample_rate=sample_rate, render_mode="offline")
        return pack_audio_node_model(model, sys_obj)

    resolved_graph = apply_snapshot(base_graph, snapshot, transient_overrides)
    settings = resolved_graph.get("settings") or {}
    bpm = float(settings.get("bpm") or 120.0)
    output_cfg = settings.get("output") or {}

    nodes_by_id: Dict[str, Dict[str, Any]] = {}
    for n in resolved_graph.get("nodes", []) or []:
        if isinstance(n, dict) and n.get("id"):
            nodes_by_id[str(n["id"])] = n

    output_root_id = str(root_id or resolved_graph.get("output") or "master")
    if output_root_id not in nodes_by_id:
        for nid, n in nodes_by_id.items():
            if n.get("role") == "master":
                output_root_id = nid
                break

    # Build child -> parent routing map from audio connections
    parent_of: Dict[str, str] = {}
    children_of: Dict[str, List[str]] = {}
    for conn in resolved_graph.get("connections", []) or []:
        if not isinstance(conn, dict):
            continue
        if conn.get("type", "audio") != "audio":
            continue
        src = str(conn.get("from") or "")
        dst = str(conn.get("to") or "")
        if src in nodes_by_id and dst in nodes_by_id:
            parent_of[src] = dst
            children_of.setdefault(dst, []).append(src)

    # Check if canonical graph contains sequence/arrangement/cooked processor nodes; if so, delegate via ERMES AudioNodeModel
    has_procedural = any(
        str(n.get("type") or "").lower() in ("sequence", "arrangement", "preamp_denoise", "voice_isolator")
        for n in nodes_by_id.values()
    )
    if has_procedural:
        for n in nodes_by_id.values():
            props = n.get("properties") or {}
            if props.get("filepath"):
                props["filepath"] = _resolve_relative_filepath(props["filepath"], project_root)
            for slot in props.get("slots") or []:
                if isinstance(slot, dict) and slot.get("filepath"):
                    slot["filepath"] = _resolve_relative_filepath(slot["filepath"], project_root)
        model = compile_canonical_graph_to_audio_node_model(resolved_graph, root_id=root_id)
        sys_obj = System(bpm=bpm, sample_rate=sample_rate, render_mode="offline")
        plan = pack_audio_node_model(model, sys_obj)
        if isinstance(output_cfg, dict):
            plan.normalize = bool(output_cfg.get("normalize", False))
            plan.target_peak_db = float(output_cfg.get("target_peak_db", -1.0))
        return plan

    plan = SinRenderPlan(
        sample_rate=int(sample_rate or SIN_DEFAULT_SAMPLE_RATE),
        bpm=bpm,
        normalize=bool(output_cfg.get("normalize", False)) if isinstance(output_cfg, dict) else False,
        target_peak_db=float(output_cfg.get("target_peak_db", -1.0)) if isinstance(output_cfg, dict) else -1.0,
    )

    solo_set = {str(s) for s in (solo_ids or [])}

    # Explicit total_bars on root or settings ("auto" => 0.0 unconstrained)
    root_node = nodes_by_id.get(output_root_id, {})
    root_props = root_node.get("properties") or {}
    raw_bars = root_props.get("total_bars")
    if raw_bars is None:
        raw_bars = settings.get("total_bars")
    if not _is_auto_bars(raw_bars):
        bars_val = float(raw_bars)
        plan.explicit_duration_sec = bars_val * 4.0 * (60.0 / bpm)

    # Collect reachable nodes from output_root_id (null nodes enforce single-input pass-through)
    reachable: List[str] = []
    visited = set()
    stack = [output_root_id]
    while stack:
        nid = stack.pop()
        if nid in visited or nid not in nodes_by_id:
            continue
        visited.add(nid)
        reachable.append(nid)
        node_cids = children_of.get(nid, [])
        if str(nodes_by_id[nid].get("type") or "").lower() == "null":
            node_cids = node_cids[:1]
        for cid in node_cids:
            stack.append(cid)

    # Assign Bus IDs to every non-sample node (master = 1)
    next_bus_id = 1
    bus_node_ids: List[str] = [output_root_id] + [
        nid for nid in reachable
        if nid != output_root_id and str(nodes_by_id[nid].get("type") or "").lower() != "sample"
    ]
    for nid in bus_node_ids:
        bid = next_bus_id
        next_bus_id += 1
        plan.bus_id_map[nid] = bid
        plan.bus_key_map[bid] = nid

    # Build BusSpecs + ordered ChainStageSpecs
    bus_by_id: Dict[int, BusSpec] = {}
    for nid in bus_node_ids:
        node = nodes_by_id[nid]
        props = node.get("properties") or {}
        bid = plan.bus_id_map[nid]
        p_nid = parent_of.get(nid)
        parent_bid = plan.bus_id_map.get(p_nid, 0) if (nid != output_root_id and p_nid) else 0
        pre_db, vol, post_db, muted = _chain_to_bus_gains(props.get("chain"), props.get("gain"))
        pan = float(props.get("pan") or 0.0)
        bs = BusSpec(
            bus_id=bid,
            parent_bus_id=parent_bid,
            node_key=nid,
            node_type=str(node.get("type") or "track"),
            node_name=str(props.get("node_name") or nid),
            pre_gain_db=pre_db,
            volume=vol,
            post_gain_db=post_db,
            pan=pan,
            muted=muted,
            solo=(nid in solo_set),
        )
        plan.buses.append(bs)
        bus_by_id[bid] = bs
        plan.stages.extend(_pack_chain_stages(bid, props.get("chain")))

    # Register sample nodes as sources + clips attached to their parent bus (or own bus if FX present)
    next_src_id = 1
    next_clip_id = 1
    for nid in reachable:
        node = nodes_by_id[nid]
        if str(node.get("type") or "").lower() != "sample":
            continue
        props = node.get("properties") or {}
        raw_fp = props.get("filepath")
        if not raw_fp and isinstance(props.get("slots"), list) and props["slots"]:
            active_slot = int(props.get("active_slot") or 0)
            s_idx = active_slot if 0 <= active_slot < len(props["slots"]) else 0
            raw_fp = (props["slots"][s_idx] or {}).get("filepath")
        resolved_fp = _resolve_relative_filepath(raw_fp, project_root)
        if not resolved_fp or not os.path.isfile(resolved_fp):
            continue

        parent_nid = parent_of.get(nid, output_root_id)
        parent_bid = plan.bus_id_map.get(parent_nid, 1)
        sample_stages = _pack_chain_stages(0, props.get("chain"))
        sample_pre, sample_vol, sample_post, sample_muted = _chain_to_bus_gains(props.get("chain"), props.get("gain"))
        if sample_stages:
            target_bid = next_bus_id
            next_bus_id += 1
            sample_bs = BusSpec(
                bus_id=target_bid,
                parent_bus_id=parent_bid,
                node_key=nid,
                node_type="sample",
                node_name=str(props.get("node_name") or nid),
                pre_gain_db=sample_pre,
                volume=sample_vol,
                post_gain_db=sample_post,
                pan=float(props.get("pan") or 0.0),
                muted=sample_muted,
                solo=(nid in solo_set),
            )
            plan.buses.append(sample_bs)
            bus_by_id[target_bid] = sample_bs
            plan.bus_id_map[nid] = target_bid
            plan.bus_key_map[target_bid] = nid
            for st in sample_stages:
                st.bus_id = target_bid
            plan.stages.extend(sample_stages)
            clip_gain = 1.0
        else:
            target_bid = parent_bid
            # Also allow frontend/caller to address this channel by its sample src_node_id!
            plan.bus_id_map[nid] = target_bid
            if nid in solo_set and target_bid in bus_by_id:
                bus_by_id[target_bid].solo = True
            clip_gain = (0.0 if sample_muted else 1.0) * sample_vol * (10.0 ** ((sample_pre + sample_post) / 20.0))

        src_id = next_src_id
        next_src_id += 1

        crop_start = max(0.0, min(1.0, float(props.get("crop_start") or 0.0)))
        crop_end = max(crop_start, min(1.0, float(props.get("crop_end") if props.get("crop_end") is not None else 1.0)))
        is_repeat = _is_repeat_enabled(props)

        # Bind crop bounds onto channel bus so live CROP_START / CROP_END updates take effect in <3ms
        if target_bid in bus_by_id:
            bus_by_id[target_bid].crop_start = crop_start
            bus_by_id[target_bid].crop_end = crop_end

        if _needs_offline_stretch(props, bpm):
            cooked_audio, cooked_hash = _cook_stretched_sample(
                resolved_fp,
                props,
                bpm,
                plan.sample_rate,
                crop_start=crop_start,
                crop_end=crop_end,
                fast_preview=False,
            )
            plan.sources.append(SourceSpec(
                source_id=src_id,
                pcm=cooked_audio,
                sample_rate=plan.sample_rate,
                content_hash=cooked_hash,
                num_frames=int(cooked_audio.shape[-1]),
            ))
            rate = 1.0
            clip_s0, clip_s1 = 0.0, 1.0
            flags = SIN_CLIP_LOOP_SOURCE if is_repeat else 0
        else:
            plan.sources.append(SourceSpec(
                source_id=src_id,
                filepath=resolved_fp,
                force_ram=False,  # auto: RAM < 30s, lock-free disk stream >= 30s (8GB safe!)
            ))
            rate = _varispeed_rate(props, bpm)
            clip_s0, clip_s1 = crop_start, crop_end
            flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND
            if is_repeat:
                flags |= SIN_CLIP_LOOP_SOURCE

        start_beat = float(props.get("start_beat") or 0.0)
        start_frame = int(round(start_beat * (60.0 / bpm) * plan.sample_rate))
        clip_len_frames = 0
        if is_repeat and plan.explicit_duration_sec > 0.0:
            clip_len_frames = max(0, int(round(plan.explicit_duration_sec * plan.sample_rate)) - start_frame)

        plan.clips.append(ClipSpec(
            clip_id=next_clip_id,
            source_id=src_id,
            target_bus_id=target_bid,
            timeline_start_frame=start_frame,
            timeline_length_frames=clip_len_frames,
            source_start_ratio=clip_s0,
            source_end_ratio=clip_s1,
            gain=float(clip_gain),
            playback_rate=float(rate),
            flags=flags,
        ))
        next_clip_id += 1

    return plan


def pack_audio_node_model(
    node_model: Any,
    system: Optional[System] = None,
) -> SinRenderPlan:
    """Pack a SIN `AudioNodeModel` (or dict) into a flat `SinRenderPlan` for `libsin_dsp`.

    - Preserves 100% of SIN's ERMES `slot_language.py` pseudolanguage, pools, seeds,
      Sequence step/choke/release/fade semantics, and Arrangement section semantics.
    - Assigns every node its own real-time `BusSpec` in `libsin_dsp` so live Gain / Volume /
      Pan / Mute / Solo / Crop / Varispeed edits run natively in C++ in < 5 ms!
    """
    from core.engines import build_node_object

    bpm = float(getattr(node_model, "bpm", None) or (node_model.get("bpm") if isinstance(node_model, dict) else 120.0) or 120.0)
    sr = int(system.sample_rate) if system is not None else SIN_DEFAULT_SAMPLE_RATE
    sys_obj = system if system is not None else System(bpm=bpm, sample_rate=sr, render_mode="preview")
    root_obj = build_node_object(node_model)
    return pack_audio_object(root_obj, sys_obj)


def _hash_array(arr: np.ndarray, salt: str = "") -> int:
    h = hashlib.blake2b(digest_size=8)
    h.update(salt.encode("utf-8"))
    h.update(str(arr.shape).encode("utf-8"))
    if arr.size > 0:
        flat = arr.reshape(-1)
        step = max(1, flat.size // 64)
        h.update(np.ascontiguousarray(flat[::step], dtype=np.float32).tobytes())
    return int.from_bytes(h.digest(), "little")


def _probe_file_info(filepath: str) -> Optional[Tuple[int, int, float]]:
    """Header-only audio probe returning `(sample_rate, num_frames, duration_sec)` in <0.5ms (0 RAM)."""
    if not filepath or not os.path.isfile(filepath):
        return None
    try:
        import soundfile as sf
        info = sf.info(filepath)
        sr = int(info.samplerate or 0)
        frames = int(info.frames or 0)
        if sr > 0 and frames > 0:
            return sr, frames, float(frames) / float(sr)
    except Exception:
        pass
    return None


def _resolve_sample_leaf_filepath(
    obj: Any,
    bpm: float,
    *,
    allow_warped: bool = False,
) -> Optional[Tuple[str, Dict[str, Any], float, float, float]]:
    """Return `(resolved_fp, props_like, crop_start, crop_end, eff_playback_rate)` if `obj` is a direct disk Sample leaf."""
    if str(getattr(obj, "node_type", "") or "").lower() != "sample":
        return None
    if getattr(obj, "children", None) or getattr(obj, "audio_data", None) is not None:
        return None
    slots = getattr(obj, "slots", None) or []
    active_slot = int(getattr(obj, "active_slot", 0) or 0)
    slot_cfg = slots[active_slot] if (0 <= active_slot < len(slots) and isinstance(slots[active_slot], dict)) else {}
    fp = slot_cfg.get("filepath") or getattr(obj, "filepath", None)
    selected_items = getattr(obj, "selected_items", None) or []
    slot_query = slot_cfg.get("pool_query") if slot_cfg.get("pool_query") is not None else getattr(obj, "pool_query", None)
    slot_query_str = str(slot_query or "").strip()
    has_dynamic_pool = bool(slot_query_str and is_field_operator_expression(slot_query_str, selected_items))
    has_dynamic_ops = bool(
        getattr(obj, "field_operators", None)
        or slot_cfg.get("field_operators")
        or has_dynamic_pool
    )
    if has_dynamic_ops:
        return None
    if slot_query_str and selected_items:
        eff_pool_seed = int(getattr(obj, "global_seed", 0) or 0)
        eff_pool_node_id = int(getattr(obj, "pool_node_id", None) or getattr(obj, "node_id", None) or 0)
        chosen = resolve_pool_item_by_query(
            selected_items,
            slot_query_str,
            slot_index=active_slot,
            slot_seed=int(getattr(obj, "seed", 0) or 0),
            is_sequential=False,
            trigger_count=int(getattr(obj, "trigger_count", 0) or 0),
            pool_seed=eff_pool_seed,
            node_id=eff_pool_node_id,
        )
        if chosen:
            chosen_fp = chosen.get("absolute_path") or chosen.get("filepath")
            if chosen_fp:
                fp = chosen_fp
    if not fp:
        return None
    resolved_fp = _resolve_relative_filepath(fp, None)
    if not resolved_fp or not os.path.isfile(resolved_fp):
        return None
    eff_target_bpm = float(getattr(obj, "target_bpm", None) or bpm)
    props_like = {
        "repeat": slot_cfg.get("repeat") if slot_cfg.get("repeat") is not None else getattr(obj, "repeat", None),
        "warp": slot_cfg.get("warp") if slot_cfg.get("warp") is not None else getattr(obj, "warp", None),
        "stretch_mode": getattr(obj, "stretch_mode", "time_stretch"),
        "stretch_factor": slot_cfg.get("time_stretch") if slot_cfg.get("time_stretch") is not None else getattr(obj, "stretch_factor", 1.0),
        "stretch_algorithm": getattr(obj, "stretch_algorithm", "rubberband"),
        "transpose": slot_cfg.get("pitch_shift") if slot_cfg.get("pitch_shift") is not None else getattr(obj, "transpose", 0.0),
        "cents": getattr(obj, "cents", 0.0),
        "original_bpm": slot_cfg.get("original_bpm") if slot_cfg.get("original_bpm") is not None else getattr(obj, "original_bpm", None),
        "target_bpm": eff_target_bpm,
        "sample_type": getattr(obj, "sample_type", "loop"),
        "key_match_mode": getattr(obj, "key_match_mode", "off"),
        "key_match_algorithm": getattr(obj, "key_match_algorithm", "nearest"),
    }
    needs_stretch = _needs_offline_stretch(props_like, eff_target_bpm)
    if needs_stretch and not allow_warped:
        return None
    cs = max(0.0, min(1.0, float(slot_cfg.get("crop_start") if slot_cfg.get("crop_start") is not None else getattr(obj, "crop_start", 0.0))))
    ce = max(cs, min(1.0, float(slot_cfg.get("crop_end") if slot_cfg.get("crop_end") is not None else getattr(obj, "crop_end", 1.0))))
    if needs_stretch:
        _is_w, tempo_rate, _semis, _algo = _effective_stretch_params(props_like, eff_target_bpm)
        rate = tempo_rate
    else:
        rate = _varispeed_rate(props_like, eff_target_bpm)
    return resolved_fp, props_like, cs, ce, rate


def _extract_tiled_processor_chain(obj: Any, bpm: float) -> Optional[Tuple[List[Any], Any, Tuple[str, Dict[str, Any], float, float, float]]]:
    """Walk an upstream serial chain of RX processor / null nodes down to a single disk-backed Sample leaf.

    Returns `(processor_objs_upstream_to_downstream, leaf_sample_obj, leaf_meta)` or None.
    """
    proc_chain_rev: List[Any] = []
    cur = obj
    visited: set[int] = set()
    while cur is not None:
        oid = id(cur)
        if oid in visited:
            return None
        visited.add(oid)
        ntype = str(getattr(cur, "node_type", "") or "").lower()
        children = getattr(cur, "children", None) or []
        if ntype in ("preamp_denoise", "voice_isolator"):
            proc_chain_rev.append(cur)
            if len(children) != 1:
                return None
            # Require zero beat offset on serial chain link so tile grid aligns 1:1 with source
            if abs(float(children[0][0] or 0.0)) > 1e-4:
                return None
            cur = children[0][1]
        elif ntype == "null":
            if len(children) != 1:
                return None
            if abs(float(children[0][0] or 0.0)) > 1e-4:
                return None
            cur = children[0][1]
        elif ntype == "sample":
            leaf_meta = _resolve_sample_leaf_filepath(cur, bpm, allow_warped=True)
            if leaf_meta is None:
                return None
            proc_chain_rev.reverse()
            return proc_chain_rev, cur, leaf_meta
        else:
            return None
    return None


def _resolve_longest_finite_source_sec(root_obj: Any, bpm: float) -> float:
    """Fast header-only walk returning the longest finite audio source duration (seconds) in the graph."""
    max_sec = 0.0
    stack: List[Tuple[float, Any]] = [(0.0, root_obj)]
    visited: set[int] = set()
    sec_per_beat = 60.0 / max(1.0, float(bpm or 120.0))
    while stack:
        offset_sec, node = stack.pop()
        if node is None or id(node) in visited:
            continue
        visited.add(id(node))
        ntype = str(getattr(node, "node_type", "") or "").lower()
        if ntype == "sample":
            meta = _resolve_sample_leaf_filepath(node, bpm, allow_warped=True)
            if meta is not None:
                resolved_fp, _props, cs, ce, rate = meta
                info = _probe_file_info(resolved_fp)
                if info is not None:
                    _, _, raw_dur = info
                    span = max(0.0, (ce - cs) * raw_dur) / max(1e-4, rate)
                    max_sec = max(max_sec, offset_sec + span)
        for start_beat, child in (getattr(node, "children", None) or []):
            stack.append((offset_sec + float(start_beat or 0.0) * sec_per_beat, child))
    return max_sec


def pack_audio_object(root_obj: Any, system: System) -> SinRenderPlan:
    """Pack an instantiated `AudioObject` tree into a `SinRenderPlan`.

    Leaf `SampleObject`s without offline stretching register direct disk/RAM file sources with live
    crop & rate bindings; long-track RX processor chains (`preamp_denoise`, `voice_isolator`) register
    zero-RAM layered tile streaming sources; `SequenceObject` / `ArrangementObject` / stretched sources
    evaluate their exact procedural audio via SIN's unchanged symbolic/cooking rules while keeping
    every bus live-mixable in `libsin_dsp`!
    """
    from core.env_config import get_env_config
    from core.processors.tile_scheduler import TiledStageSpec, TiledTrackSessionSpec

    sr = int(system.sample_rate or SIN_DEFAULT_SAMPLE_RATE)
    bpm = float(system.bpm or 120.0)
    plan = SinRenderPlan(sample_rate=sr, bpm=bpm)

    raw_root_bars = getattr(root_obj, "total_bars", None)
    is_free_mode = raw_root_bars is None or float(raw_root_bars) <= 0.0
    root_bars: Optional[float] = None if is_free_mode else float(raw_root_bars)
    free_target_sec = _resolve_longest_finite_source_sec(root_obj, bpm) if is_free_mode else 0.0
    free_target_frames = int(round(free_target_sec * sr)) if free_target_sec > 0.0 else 0
    sec_per_bar = 4.0 * (60.0 / max(1.0, bpm))
    if not is_free_mode and root_bars is not None:
        plan.explicit_duration_sec = root_bars * sec_per_bar
    else:
        plan.explicit_duration_sec = 0.0  # unconstrained auto duration in libsin_dsp

    # Dedicated transparent output monitor bus so SIN footer Master Volume/Mute
    # never collide with Master Track node's own FX chain Gain!
    monitor_bus = BusSpec(
        bus_id=1,
        parent_bus_id=0,
        node_key="__monitor__",
        node_type="monitor",
        node_name="Monitor",
    )
    plan.buses.append(monitor_bus)
    plan.bus_id_map["__monitor__"] = 1
    plan.bus_key_map[1] = "__monitor__"

    state = {"bus_id": 2, "src_id": 1, "clip_id": 1}

    def _alloc_bus(obj: Any, parent_bus_id: int) -> BusSpec:
        bid = state["bus_id"]
        state["bus_id"] += 1
        raw_nid = getattr(obj, "node_id", None)
        node_key = str(raw_nid) if raw_nid is not None else f"bus_{bid}"
        pre_db, vol, post_db, muted = _chain_to_bus_gains(getattr(obj, "chain", None))
        bs = BusSpec(
            bus_id=bid,
            parent_bus_id=parent_bus_id,
            node_key=node_key,
            node_type=str(getattr(obj, "node_type", "track") or "track"),
            node_name=str(getattr(obj, "name", node_key) or node_key),
            pre_gain_db=pre_db,
            volume=vol,
            post_gain_db=post_db,
            pan=float(getattr(obj, "pan", 0.0) or 0.0),
            crop_start=float(getattr(obj, "crop_start", 0.0) or 0.0),
            crop_end=float(getattr(obj, "crop_end", 1.0) if getattr(obj, "crop_end", None) is not None else 1.0),
            playback_rate=1.0,
            muted=bool(muted or getattr(obj, "muted", False)),
            solo=bool(getattr(obj, "solo", False)),
        )
        plan.buses.append(bs)
        plan.bus_id_map[node_key] = bid
        plan.bus_key_map[bid] = node_key
        plan.stages.extend(_pack_chain_stages(bid, getattr(obj, "chain", None)))
        return bs

    def _pack_node(
        obj: Any,
        parent_bus_id: int,
        start_frame_offset: int,
        parent_bars: Optional[float],
        wrapper_idx: int = 0,
        wrapper_progress: Optional[float] = None,
        num_wrapper_cycles: int = 1,
    ) -> int:
        bs = _alloc_bus(obj, parent_bus_id)
        ntype = str(getattr(obj, "node_type", "track") or "track").lower()
        children = getattr(obj, "children", None) or []

        # Strict single-cable pass-through Null node (no summing; passes single child through bus FX chain)
        if ntype == "null":
            if not children:
                return 0
            child_start_beat, child_obj = children[0]
            c_start = start_frame_offset + int(round(float(child_start_beat) * (60.0 / bpm) * sr))
            return _pack_node(
                child_obj,
                bs.bus_id,
                c_start,
                parent_bars,
                wrapper_idx=wrapper_idx,
                wrapper_progress=wrapper_progress,
                num_wrapper_cycles=num_wrapper_cycles,
            )

        # Composite Track / Master / Bus container: pack children onto child buses -> C++ mixes them!
        if ntype not in ("sequence", "arrangement", "sample", "asset_filter", "preamp_denoise", "voice_isolator") and children:
            mix_mode = str(getattr(obj, "mix_mode", "sum") or "sum").lower()
            own_bars = getattr(obj, "total_bars", None)
            eff_bars = own_bars if (own_bars is not None and float(own_bars) > 0.0) else parent_bars
            cursor_frames = start_frame_offset
            max_end_frame = start_frame_offset

            for child_start_beat, child_obj in children:
                if mix_mode == "chained":
                    c_start = cursor_frames
                else:
                    c_start = start_frame_offset + int(round(float(child_start_beat) * (60.0 / bpm) * sr))

                c_type = str(getattr(child_obj, "node_type", "track") or "track").lower()
                c_bars = getattr(child_obj, "total_bars", None)
                if (
                    eff_bars is not None
                    and float(eff_bars) > 0.0
                    and c_type in ("track", "arrangement")
                    and c_bars is not None
                    and 0.0 < float(c_bars) < float(eff_bars)
                ):
                    wrapped_cycles = max(1, int(math.ceil(float(eff_bars) / float(c_bars))))
                    child_bar_frames = max(1, int(round(float(c_bars) * 4.0 * (60.0 / bpm) * sr)))
                    total_c_dur = wrapped_cycles * child_bar_frames
                    for w_idx in range(wrapped_cycles):
                        cum_w = wrapper_idx * wrapped_cycles + w_idx
                        w_prog = float(w_idx) / float(wrapped_cycles)
                        _pack_node(
                            child_obj,
                            bs.bus_id,
                            c_start + w_idx * child_bar_frames,
                            float(c_bars),
                            wrapper_idx=cum_w,
                            wrapper_progress=w_prog,
                            num_wrapper_cycles=wrapped_cycles,
                        )
                    c_dur = total_c_dur
                else:
                    c_dur = _pack_node(
                        child_obj,
                        bs.bus_id,
                        c_start,
                        eff_bars,
                        wrapper_idx=wrapper_idx,
                        wrapper_progress=wrapper_progress,
                        num_wrapper_cycles=num_wrapper_cycles,
                    )

                if mix_mode == "chained":
                    cursor_frames += c_dur
                max_end_frame = max(max_end_frame, c_start + c_dur)

            if eff_bars is not None and float(eff_bars) > 0.0:
                return int(round(float(eff_bars) * 4.0 * (60.0 / bpm) * sr))
            return max(0, max_end_frame - start_frame_offset)

        # Direct / Crop-Aware / Tiled-RubberBand Sample leaf fast paths (ZERO full-file RAM cliff!)
        if ntype == "sample" and not children and getattr(obj, "audio_data", None) is None:
            from ermes.py.slot_language import is_field_operator_expression, resolve_pool_item_by_query
            slots = getattr(obj, "slots", None) or []
            active_slot = int(getattr(obj, "active_slot", 0) or 0)
            slot_cfg = slots[active_slot] if (0 <= active_slot < len(slots) and isinstance(slots[active_slot], dict)) else {}
            selected_items = getattr(obj, "selected_items", None) or []
            slot_query = slot_cfg.get("pool_query") if slot_cfg.get("pool_query") is not None else getattr(obj, "pool_query", None)
            slot_query_str = str(slot_query or "").strip()
            has_dynamic_pool_op = is_field_operator_expression(slot_query_str, selected_items)
            has_dynamic_ops = bool(getattr(obj, "field_operators", None) or slot_cfg.get("field_operators") or has_dynamic_pool_op)
            fp = slot_cfg.get("filepath") or getattr(obj, "filepath", None)
            if selected_items and slot_query_str and not has_dynamic_pool_op:
                eff_pool_node_id = int(getattr(obj, "pool_node_id", None) or getattr(obj, "node_id", None) or 0)
                chosen = resolve_pool_item_by_query(
                    selected_items,
                    slot_query_str,
                    slot_index=active_slot,
                    slot_seed=getattr(obj, "field_seed", None) if getattr(obj, "field_seed", None) is not None else getattr(obj, "seed", 42),
                    pool_seed=getattr(obj, "global_seed", None),
                    node_id=eff_pool_node_id,
                )
                if chosen:
                    fp = chosen.get("absolute_path") or chosen.get("filepath") or fp
            eff_target_bpm = float(getattr(obj, "target_bpm", None) or bpm)
            props_like = {
                "repeat": slot_cfg.get("repeat") if slot_cfg.get("repeat") is not None else getattr(obj, "repeat", None),
                "warp": slot_cfg.get("warp") if slot_cfg.get("warp") is not None else getattr(obj, "warp", None),
                "stretch_mode": getattr(obj, "stretch_mode", "time_stretch"),
                "stretch_factor": slot_cfg.get("time_stretch") if slot_cfg.get("time_stretch") is not None else getattr(obj, "stretch_factor", 1.0),
                "stretch_algorithm": getattr(obj, "stretch_algorithm", "rubberband"),
                "transpose": slot_cfg.get("pitch_shift") if slot_cfg.get("pitch_shift") is not None else getattr(obj, "transpose", 0.0),
                "cents": getattr(obj, "cents", 0.0),
                "original_bpm": slot_cfg.get("original_bpm") if slot_cfg.get("original_bpm") is not None else getattr(obj, "original_bpm", None),
                "target_bpm": eff_target_bpm,
                "sample_type": getattr(obj, "sample_type", "loop"),
                "key_match_mode": getattr(obj, "key_match_mode", "off"),
                "key_match_algorithm": getattr(obj, "key_match_algorithm", "nearest"),
            }
            resolved_fp = _resolve_relative_filepath(fp, None) if fp else None
            if resolved_fp and os.path.isfile(resolved_fp) and not has_dynamic_ops:
                from core.runtime_trace import trace_runtime
                cs = max(0.0, min(1.0, float(slot_cfg.get("crop_start") if slot_cfg.get("crop_start") is not None else getattr(obj, "crop_start", 0.0))))
                ce = max(cs, min(1.0, float(slot_cfg.get("crop_end") if slot_cfg.get("crop_end") is not None else getattr(obj, "crop_end", 1.0))))
                is_repeat = _is_repeat_enabled(props_like)
                is_standalone_root = obj is root_obj
                own_bars = getattr(obj, "total_bars", None)
                eff_bars = own_bars if (own_bars is not None and float(own_bars) > 0.0) else parent_bars
                is_warp, tempo_rate, semis, stretch_algo = _effective_stretch_params(props_like, eff_target_bpm)
                needs_stretch = is_warp and (abs(tempo_rate - 1.0) > 1e-4 or abs(semis) > 1e-4)
                finfo = _probe_file_info(resolved_fp)
                tile_sec = float(get_env_config().tile_sec)
                active_span_sec = ((ce - cs) * finfo[2]) if finfo is not None else 0.0

                def _resolve_repeat_clip_len(own_dur_sec: float) -> Tuple[int, bool]:
                    if not is_repeat or is_standalone_root:
                        return 0, False
                    if eff_bars is not None and float(eff_bars) > 0.0:
                        return int(round(float(eff_bars) * sec_per_bar * sr)), True
                    if is_free_mode:
                        if free_target_frames > 0 and own_dur_sec + 0.05 < free_target_sec:
                            return max(0, free_target_frames - start_frame_offset), True
                        if free_target_frames <= 0:
                            return int(round(4.0 * sec_per_bar * sr)), True
                    return 0, False

                if not needs_stretch:
                    # Case A: Unstretched or Tape/Varispeed -> zero-RAM C++ direct file/stream source
                    trace_runtime(f"Native libsin_dsp source registered: {Path(resolved_fp).name}")
                    src_id = state["src_id"]
                    state["src_id"] += 1
                    plan.sources.append(SourceSpec(source_id=src_id, filepath=resolved_fp, force_ram=False))

                    rate = _varispeed_rate(props_like, eff_target_bpm)
                    bs.crop_start = cs
                    bs.crop_end = ce
                    bs.playback_rate = rate

                    own_dur = (active_span_sec / max(1e-4, rate)) if finfo else 0.0
                    clip_len, should_loop = _resolve_repeat_clip_len(own_dur)
                    flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND
                    if should_loop:
                        flags |= SIN_CLIP_LOOP_SOURCE

                    clip_id = state["clip_id"]
                    state["clip_id"] += 1
                    plan.clips.append(ClipSpec(
                        clip_id=clip_id,
                        source_id=src_id,
                        target_bus_id=bs.bus_id,
                        timeline_start_frame=start_frame_offset,
                        timeline_length_frames=clip_len,
                        source_start_ratio=cs,
                        source_end_ratio=ce,
                        gain=1.0,
                        playback_rate=1.0,  # scaled live by bs.playback_rate via SIN_CLIP_LIVE_RATE_BOUND
                        flags=flags,
                    ))
                    if getattr(obj, "node_id", None) is not None:
                        system.record_node_event(obj.node_id, {
                            "time": round(float(start_frame_offset) / float(sr), 4),
                            "duration": round(float(clip_len) / float(sr), 4) if clip_len > 0 else round(own_dur, 4),
                            "filepath": resolved_fp,
                            "slot": active_slot,
                        })
                    return clip_len if clip_len > 0 else int(round(own_dur * sr))

                if (
                    finfo is not None
                    and active_span_sec > max(SINGLE_PASS_STRETCH_MAX_SEC, tile_sec * 2.0)
                    and system.render_mode == "preview"
                    and getattr(system, "allow_async_cook", False)
                ):
                    # Case B: Long warped slice (>16s) in preview -> zero-RAM Tiled Rubber Band over LayeredTileStore!
                    file_sr, _file_frames, file_dur_sec = finfo
                    out_dur_sec = file_dur_sec / max(0.05, tempo_rate)
                    total_out_frames = max(1, int(math.ceil(out_dur_sec * sr)))
                    tile_frames = max(4096, int(round(tile_sec * sr)))
                    num_tiles = max(1, int(math.ceil(float(total_out_frames) / float(tile_frames))))

                    src_id = state["src_id"]
                    state["src_id"] += 1
                    plan.sources.append(SourceSpec(
                        source_id=src_id,
                        filepath=resolved_fp,
                        force_ram=False,
                        sample_rate=sr,
                        num_frames=total_out_frames,
                        layered_tile_frames=tile_frames,
                        layered_num_tiles=num_tiles,
                        layered_total_frames=total_out_frames,
                        layered_node_key=bs.node_key,
                    ))

                    bs.crop_start = cs
                    bs.crop_end = ce
                    bs.playback_rate = tempo_rate

                    cropped_out_sec = active_span_sec / max(0.05, tempo_rate)
                    clip_len, should_loop = _resolve_repeat_clip_len(cropped_out_sec)
                    eff_tl_dur_sec = (float(clip_len) / float(sr)) if clip_len > 0 else cropped_out_sec
                    flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND | SIN_CLIP_TILE_TIME_STRETCHED
                    if should_loop:
                        flags |= SIN_CLIP_LOOP_SOURCE

                    clip_id = state["clip_id"]
                    state["clip_id"] += 1
                    plan.clips.append(ClipSpec(
                        clip_id=clip_id,
                        source_id=src_id,
                        target_bus_id=bs.bus_id,
                        timeline_start_frame=start_frame_offset,
                        timeline_length_frames=clip_len,
                        source_start_ratio=cs,
                        source_end_ratio=ce,
                        gain=1.0,
                        playback_rate=1.0,
                        flags=flags,
                    ))
                    system.pending_tiled_cooks.append(TiledTrackSessionSpec(
                        source_id=src_id,
                        base_filepath=resolved_fp,
                        sample_rate=sr,
                        file_sample_rate=file_sr,
                        total_frames=total_out_frames,
                        duration_sec=file_dur_sec,
                        tile_sec=tile_sec,
                        tile_frames=tile_frames,
                        num_tiles=num_tiles,
                        stages=[TiledStageSpec(
                            node_id=bs.node_key,
                            node_type="rubberband_stretch",
                            node_name=bs.node_name,
                            processor_params={
                                "tempo_rate": float(tempo_rate),
                                "semitones": float(semis),
                                "algorithm": stretch_algo,
                                "fast_engine": True,
                            },
                        )],
                        crop_start=cs,
                        crop_end=ce,
                        playback_rate=float(tempo_rate),
                        timeline_duration_sec=eff_tl_dur_sec,
                        bus_node_ids=[bs.node_key],
                        tile_time_stretched=True,
                        stretch_tempo_rate=float(tempo_rate),
                    ))
                    if getattr(obj, "node_id", None) is not None:
                        system.record_node_event(obj.node_id, {
                            "time": round(float(start_frame_offset) / float(sr), 4),
                            "duration": round(eff_tl_dur_sec, 4),
                            "filepath": resolved_fp,
                            "slot": active_slot,
                        })
                    return clip_len if clip_len > 0 else int(round(cropped_out_sec * sr))

                # Case C: Short/cropped warped slice (<=16s, even on a 1h file!) OR offline warped export
                cooked_pcm, cooked_hash = _cook_stretched_sample(
                    resolved_fp,
                    props_like,
                    eff_target_bpm,
                    sr,
                    crop_start=cs,
                    crop_end=ce,
                    fast_preview=(system.render_mode == "preview"),
                )
                if cooked_pcm is None or cooked_pcm.size == 0:
                    return 0
                pcm_f32 = np.asarray(cooked_pcm, dtype=np.float32)
                cooked_frames = int(pcm_f32.shape[-1])
                own_dur = float(cooked_frames) / float(sr)
                clip_len, should_loop = _resolve_repeat_clip_len(own_dur)

                src_id = state["src_id"]
                state["src_id"] += 1
                plan.sources.append(SourceSpec(
                    source_id=src_id,
                    pcm=pcm_f32,
                    sample_rate=sr,
                    content_hash=cooked_hash,
                    num_frames=cooked_frames,
                ))
                clip_id = state["clip_id"]
                state["clip_id"] += 1
                clip_len_out = clip_len if (should_loop and clip_len > 0) else cooked_frames
                plan.clips.append(ClipSpec(
                    clip_id=clip_id,
                    source_id=src_id,
                    target_bus_id=bs.bus_id,
                    timeline_start_frame=start_frame_offset,
                    timeline_length_frames=clip_len_out,
                    source_start_ratio=0.0,
                    source_end_ratio=1.0,
                    gain=1.0,
                    playback_rate=1.0,
                    flags=(SIN_CLIP_LOOP_SOURCE if (should_loop and clip_len_out > cooked_frames) else 0),
                ))
                if getattr(obj, "node_id", None) is not None:
                    system.record_node_event(obj.node_id, {
                        "time": round(float(start_frame_offset) / float(sr), 4),
                        "duration": round(float(clip_len_out) / float(sr), 4),
                        "filepath": resolved_fp,
                        "slot": active_slot,
                    })
                return clip_len_out

        # Long-track zero-RAM tiled RX processor chain fast path (live preview mode, composable with warped Sample!)
        if (
            ntype in ("preamp_denoise", "voice_isolator")
            and system.render_mode == "preview"
            and getattr(system, "allow_async_cook", False)
        ):
            tiled_chain = _extract_tiled_processor_chain(obj, bpm)
            if tiled_chain is not None:
                proc_objs, leaf_sample, leaf_meta = tiled_chain
                resolved_fp, leaf_props_like, cs, ce, rate = leaf_meta
                finfo = _probe_file_info(resolved_fp)
                tile_sec = float(get_env_config().tile_sec)
                # Engage zero-RAM tiled layered streamer for clips >= 2 tiles (default >= 16s)
                if finfo is not None and finfo[2] >= max(16.0, tile_sec * 2.0):
                    file_sr, _file_frames, file_dur_sec = finfo
                    leaf_target_bpm = float(leaf_props_like.get("target_bpm") or bpm)
                    leaf_is_warp, leaf_tempo_rate, leaf_semis, leaf_algo = _effective_stretch_params(leaf_props_like, leaf_target_bpm)
                    leaf_needs_stretch = leaf_is_warp and (abs(leaf_tempo_rate - 1.0) > 1e-4 or abs(leaf_semis) > 1e-4)

                    if leaf_needs_stretch:
                        out_dur_sec = file_dur_sec / max(0.05, leaf_tempo_rate)
                        total_frames_sr = max(1, int(math.ceil(out_dur_sec * sr)))
                        eff_rate = float(leaf_tempo_rate)
                    else:
                        total_frames_sr = max(1, int(round(file_dur_sec * sr)))
                        eff_rate = float(rate)

                    tile_frames = max(4096, int(round(tile_sec * sr)))
                    num_tiles = max(1, int(math.ceil(float(total_frames_sr) / float(tile_frames))))

                    src_id = state["src_id"]
                    state["src_id"] += 1
                    plan.sources.append(SourceSpec(
                        source_id=src_id,
                        filepath=resolved_fp,
                        force_ram=False,
                        sample_rate=sr,
                        num_frames=total_frames_sr,
                        layered_tile_frames=tile_frames,
                        layered_num_tiles=num_tiles,
                        layered_total_frames=total_frames_sr,
                        layered_node_key=bs.node_key,
                    ))

                    # Map upstream processor & leaf sample node keys to this bus for live telemetry
                    chain_bus_ids: List[str] = [bs.node_key]
                    for p_obj in proc_objs[:-1]:
                        p_nid = getattr(p_obj, "node_id", None)
                        if p_nid is not None:
                            plan.bus_id_map.setdefault(str(p_nid), bs.bus_id)
                            chain_bus_ids.append(str(p_nid))
                    leaf_nid = getattr(leaf_sample, "node_id", None)
                    if leaf_nid is not None:
                        plan.bus_id_map.setdefault(str(leaf_nid), bs.bus_id)
                        chain_bus_ids.append(str(leaf_nid))

                    # Preserve leaf Sample's own gain staging (Pre/Post Gain, Volume, Mute) on the clip!
                    s_pre, s_vol, s_post, s_muted = _chain_to_bus_gains(getattr(leaf_sample, "chain", None))
                    clip_gain = (0.0 if s_muted else 1.0) * s_vol * (10.0 ** ((s_pre + s_post) / 20.0))

                    bs.crop_start = cs
                    bs.crop_end = ce
                    bs.playback_rate = eff_rate

                    own_bars = getattr(obj, "total_bars", None)
                    eff_bars = own_bars if (own_bars is not None and float(own_bars) > 0.0) else parent_bars
                    clip_len = int(round(float(eff_bars) * sec_per_bar * sr)) if (eff_bars is not None and float(eff_bars) > 0.0) else 0
                    cropped_dur_sec = max(0.0, (ce - cs) * file_dur_sec) / max(0.05, eff_rate)
                    eff_tl_dur_sec = (float(clip_len) / float(sr)) if clip_len > 0 else cropped_dur_sec
                    flags = SIN_CLIP_LIVE_CROP_BOUND | SIN_CLIP_LIVE_RATE_BOUND
                    if leaf_needs_stretch:
                        flags |= SIN_CLIP_TILE_TIME_STRETCHED

                    clip_id = state["clip_id"]
                    state["clip_id"] += 1
                    plan.clips.append(ClipSpec(
                        clip_id=clip_id,
                        source_id=src_id,
                        target_bus_id=bs.bus_id,
                        timeline_start_frame=start_frame_offset,
                        timeline_length_frames=clip_len,
                        source_start_ratio=cs,
                        source_end_ratio=ce,
                        gain=float(clip_gain),
                        playback_rate=1.0,
                        flags=flags,
                    ))

                    stage_specs: List[TiledStageSpec] = []
                    if leaf_needs_stretch:
                        stage_specs.append(TiledStageSpec(
                            node_id=f"{leaf_nid if leaf_nid is not None else bs.node_key}:stretch",
                            node_type="rubberband_stretch",
                            node_name=str(getattr(leaf_sample, "name", "Sample")),
                            processor_params={
                                "tempo_rate": float(leaf_tempo_rate),
                                "semitones": float(leaf_semis),
                                "algorithm": leaf_algo,
                                "fast_engine": True,
                            },
                        ))
                    stage_specs.extend(
                        TiledStageSpec(
                            node_id=str(getattr(p_obj, "node_id", None) if getattr(p_obj, "node_id", None) is not None else p_obj.name),
                            node_type=str(getattr(p_obj, "node_type", "preamp_denoise")).lower(),
                            node_name=str(getattr(p_obj, "name", "Processor")),
                            processor_params=dict(getattr(p_obj, "processor_params", None) or {}),
                        )
                        for p_obj in proc_objs
                    )
                    system.pending_tiled_cooks.append(TiledTrackSessionSpec(
                        source_id=src_id,
                        base_filepath=resolved_fp,
                        sample_rate=sr,
                        file_sample_rate=file_sr,
                        total_frames=total_frames_sr,
                        duration_sec=file_dur_sec,
                        tile_sec=tile_sec,
                        tile_frames=tile_frames,
                        num_tiles=num_tiles,
                        stages=stage_specs,
                        crop_start=cs,
                        crop_end=ce,
                        playback_rate=eff_rate,
                        timeline_duration_sec=eff_tl_dur_sec,
                        bus_node_ids=chain_bus_ids,
                        tile_time_stretched=leaf_needs_stretch,
                        stretch_tempo_rate=float(leaf_tempo_rate) if leaf_needs_stretch else 1.0,
                    ))
                    return clip_len if clip_len > 0 else int(round(cropped_dur_sec * sr))

        # Procedural / Stretched / Sequence / Arrangement / In-memory node:
        # Evaluate with chain temporarily bypassed so `libsin_dsp` BusSpec owns ALL live gain/pan/mute/solo!
        saved_chain = getattr(obj, "chain", None)
        loop_to_free_frames = 0
        try:
            obj.chain = []
            render_kwargs: Dict[str, Any] = {
                "wrapper_idx": wrapper_idx,
                "global_idx": wrapper_idx,
                "num_wrapper_cycles": num_wrapper_cycles,
                "num_global_cycles": num_wrapper_cycles,
            }
            if wrapper_progress is not None:
                render_kwargs["wrapper_progress"] = wrapper_progress
                render_kwargs["global_progress"] = wrapper_progress
            if parent_bars is not None and float(parent_bars) > 0.0:
                render_kwargs["parent_total_bars"] = float(parent_bars)
            elif is_free_mode and ntype in ("sequence", "arrangement"):
                # In Free (-1) mode, render a compact 4-bar cycle (or node's own bars) in Python
                # and let C++ loop it across the full finite track with ZERO extra RAM!
                own_b = getattr(obj, "total_bars", None)
                cycle_bars = float(own_b) if (own_b is not None and float(own_b) > 0.0) else 4.0
                render_kwargs["parent_total_bars"] = cycle_bars
                if free_target_frames > 0:
                    loop_to_free_frames = max(0, free_target_frames - start_frame_offset)
            render_kwargs["timeline_offset_sec"] = float(start_frame_offset) / float(sr)
            pcm = obj.render(system=system, **render_kwargs)
        finally:
            obj.chain = saved_chain

        if pcm is None or pcm.size == 0:
            return 0

        pcm_f32 = np.asarray(pcm, dtype=np.float32)
        n_frames = int(pcm_f32.shape[-1])
        src_id = state["src_id"]
        state["src_id"] += 1
        plan.sources.append(SourceSpec(
            source_id=src_id,
            pcm=pcm_f32,
            sample_rate=sr,
            content_hash=_hash_array(pcm_f32, salt=bs.node_key),
            num_frames=n_frames,
        ))
        clip_id = state["clip_id"]
        state["clip_id"] += 1
        clip_flags = SIN_CLIP_LOOP_SOURCE if (loop_to_free_frames > n_frames) else 0
        clip_len_out = loop_to_free_frames if (loop_to_free_frames > n_frames) else n_frames
        plan.clips.append(ClipSpec(
            clip_id=clip_id,
            source_id=src_id,
            target_bus_id=bs.bus_id,
            timeline_start_frame=start_frame_offset,
            timeline_length_frames=clip_len_out,
            source_start_ratio=0.0,
            source_end_ratio=1.0,
            gain=1.0,
            playback_rate=1.0,
            flags=clip_flags,
        ))
        return clip_len_out

    _pack_node(root_obj, parent_bus_id=1, start_frame_offset=0, parent_bars=root_bars)
    plan.manifest_nodes = copy.deepcopy(system.manifest.get("nodes", {}))
    return plan
