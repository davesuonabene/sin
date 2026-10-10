"""SIN Terminal CLI — Headless Audio Composition, Rendering & Asset Management.

Provides full functional parity with the browser application while remaining decoupled
from DOM, canvas, and LiteGraph window state. Powered by ERMES serialization and the
Python DSP audio engine.
"""

from __future__ import annotations

import copy
import json
import math
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

import numpy as np
import soundfile as sf
import typer

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from ermes import (
    AudioNodeModel,
    compile_any_to_audio_node_model,
    validate_graph,
    collect_graph_warnings,
    graph_to_workspace,
)
from core.engines import get_renderer_for_node
from core.system import System
from core.qa import analyze_audio_buffer, analyze_audio_file, AudioQAResult


PROJECT_ROOT = Path(__file__).resolve().parent

app = typer.Typer(
    help="SIN Terminal CLI — Headless Audio Composition, Rendering & Asset Management",
    no_args_is_help=True,
)
compose_app = typer.Typer(help="Headless patch composition, validation, and conversion", no_args_is_help=True)
library_app = typer.Typer(help="Headless GAIA library asset discovery and verification", no_args_is_help=True)

app.add_typer(compose_app, name="compose")
app.add_typer(library_app, name="library")


def _get_gaia_db() -> Optional[Path]:
    candidates = [
        PROJECT_ROOT / "gaia.db",
        PROJECT_ROOT / "gaia" / "gaia.db",
        Path.cwd() / "gaia.db",
    ]
    for c in candidates:
        if c.is_file():
            return c.resolve()
    return None


# ─────────────────────────────────────────────────────────────────────────────
# 1. SERVE COMMAND
# ─────────────────────────────────────────────────────────────────────────────

@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Host address to bind"),
    port: int = typer.Option(8000, "--port", "-p", help="Port to listen on"),
    reload: bool = typer.Option(True, "--reload/--no-reload", help="Enable auto-reload"),
    debug: bool = typer.Option(True, "--debug/--no-debug", help="Enable debug logging"),
):
    """Launch SIN local web server and API daemon."""
    import uvicorn
    import logging

    log_level = "debug" if debug else "info"
    logging.basicConfig(
        level=logging.DEBUG if debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        force=True,
    )
    logging.getLogger("numba").setLevel(logging.WARNING)
    typer.echo(f"Starting SIN server on http://{host}:{port} (log level: {log_level})...")
    uvicorn.run("api:app", host=host, port=port, reload=reload, log_level=log_level)


# ─────────────────────────────────────────────────────────────────────────────
# 2. RENDER COMMAND
# ─────────────────────────────────────────────────────────────────────────────

@app.command()
def render(
    source: Optional[str] = typer.Argument(
        None,
        help="Path to sin-graph JSON, workspace preset, or '-' for stdin (defaults to saves/.current-stage.json)",
    ),
    out: Path = typer.Option(Path("output.wav"), "--out", "-o", help="Output WAV destination path"),
    mode: str = typer.Option("offline", "--mode", "-m", help="Render mode: 'offline' or 'preview'"),
    seed: Optional[float] = typer.Option(None, "--seed", "-s", help="Deterministic random seed override"),
    reroll: str = typer.Option("global", "--reroll", help="Reroll scope: 'global', 'pools', 'patterns', 'none'"),
    bpm: Optional[float] = typer.Option(None, "--bpm", help="Target tempo override"),
    key: Optional[str] = typer.Option(None, "--key", help="Musical root key override"),
    bars: Optional[float] = typer.Option(None, "--bars", help="Total bars override"),
    isolate: Optional[str] = typer.Option(None, "--isolate", "-i", help="Isolate subtree starting at node ID or name"),
    stems: bool = typer.Option(False, "--stems", help="Export individual stem WAV files for each child bus"),
    qa: bool = typer.Option(False, "--qa", help="Run automated audio QA verification on output"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON metrics to stdout"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Compile and validate graph without running DSP render"),
):
    """Headless audio DSP rendering of composition graphs or presets."""
    start_time = time.perf_counter()

    # Resolve input source
    if source is None or source == "":
        default_stage = PROJECT_ROOT / "saves" / ".current-stage.json"
        if default_stage.is_file():
            source = str(default_stage)
        else:
            typer.secho("Error: No source file specified and saves/.current-stage.json does not exist.", fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1)

    if source == "-":
        raw_text = sys.stdin.read()
        try:
            data = json.loads(raw_text)
        except Exception as e:
            typer.secho(f"Error parsing JSON from stdin: {e}", fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1)
    else:
        src_path = Path(source)
        if not src_path.is_file():
            typer.secho(f"Error: Source file not found: {src_path}", fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1)
        try:
            with open(src_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            typer.secho(f"Error reading JSON from {src_path}: {e}", fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1)

    # Compile graph to AudioNodeModel via ERMES
    try:
        model = compile_any_to_audio_node_model(data, isolate_target=isolate)
    except Exception as e:
        typer.secho(f"ERMES Compilation Error: {e}", fg=typer.colors.RED, err=True)
        if json_output:
            print(json.dumps({"status": "error", "message": str(e)}))
        raise typer.Exit(code=1)

    # Apply overrides
    if bpm is not None:
        model.bpm = float(bpm)
        model.target_bpm = float(bpm)
    if key is not None:
        model.key = str(key)
    if bars is not None:
        model.total_bars = float(bars)
    if seed is not None:
        model.seed = float(seed)

    if dry_run:
        result_payload = {
            "status": "success",
            "dry_run": True,
            "source": str(source),
            "root_node": model.node_name,
            "node_type": model.node_type,
            "bpm": model.bpm,
            "total_bars": model.total_bars,
            "children_count": len(model.children),
        }
        if json_output:
            print(json.dumps(result_payload, indent=2))
        else:
            typer.secho(f"[DRY RUN] Graph '{model.node_name}' compiled successfully.", fg=typer.colors.GREEN)
            typer.echo(f"  BPM: {model.bpm} | Bars: {model.total_bars} | Submix children: {len(model.children)}")
        return

    # Execute DSP rendering
    sys_env = System(bpm=model.bpm, render_mode=mode)
    renderer = get_renderer_for_node(model.node_type)

    try:
        audio_out = renderer.render(model, sys_env)
    except Exception as e:
        typer.secho(f"DSP Render Error: {e}", fg=typer.colors.RED, err=True)
        if json_output:
            print(json.dumps({"status": "error", "message": f"DSP error: {e}"}))
        raise typer.Exit(code=1)

    # Export main audio
    out.parent.mkdir(parents=True, exist_ok=True)
    export_data = np.moveaxis(audio_out, -1, 0) if audio_out.ndim > 1 else audio_out
    sf.write(str(out), export_data, sys_env.sample_rate)

    # Render stems if requested
    stem_files: List[str] = []
    if stems and model.children:
        stems_dir = out.parent / f"{out.stem}_stems"
        stems_dir.mkdir(parents=True, exist_ok=True)
        for idx, child in enumerate(model.children):
            c_renderer = get_renderer_for_node(child.node_type)
            try:
                c_audio = c_renderer.render(child, sys_env)
                clean_name = "".join(c for c in child.node_name if c.isalnum() or c in ("-", "_")).strip() or f"stem_{idx+1}"
                stem_path = stems_dir / f"{idx+1:02d}_{clean_name}.wav"
                c_export = np.moveaxis(c_audio, -1, 0) if c_audio.ndim > 1 else c_audio
                sf.write(str(stem_path), c_export, sys_env.sample_rate)
                stem_files.append(str(stem_path))
            except Exception as se:
                typer.secho(f"Warning: Failed rendering stem '{child.node_name}': {se}", fg=typer.colors.YELLOW, err=True)

    elapsed = time.perf_counter() - start_time
    qa_metrics = analyze_audio_buffer(audio_out, sys_env.sample_rate)

    if json_output:
        summary = {
            "status": "success",
            "source": str(source),
            "output_file": str(out),
            "bpm": model.bpm,
            "total_bars": model.total_bars,
            "render_time_seconds": round(elapsed, 3),
            "metrics": qa_metrics.to_dict(),
            "stems": stem_files,
        }
        print(json.dumps(summary, indent=2))
    else:
        typer.secho(f"[OK] Render complete: {out}", fg=typer.colors.GREEN, bold=True)
        typer.echo(f"  Duration: {qa_metrics.duration_seconds:.2f}s | Peak: {qa_metrics.peak_db:.1f} dB | RMS: {qa_metrics.rms_db:.1f} dB")
        if stem_files:
            typer.echo(f"  Exported {len(stem_files)} stems to: {out.parent / f'{out.stem}_stems'}")
        if qa_metrics.has_clipping:
            typer.secho(f"  [WARN] Warning: {qa_metrics.clipping_samples} clipped samples detected!", fg=typer.colors.YELLOW)
        if qa_metrics.is_silent:
            typer.secho("  [WARN] Warning: Audio output is silent!", fg=typer.colors.YELLOW)
        typer.echo(f"  Elapsed: {elapsed:.2f}s")


# ─────────────────────────────────────────────────────────────────────────────
# 3. COMPOSE SUBCOMMANDS
# ─────────────────────────────────────────────────────────────────────────────

@compose_app.command("validate")
def compose_validate(
    path: Path = typer.Argument(..., help="Path to sin-graph JSON document"),
    strict: bool = typer.Option(False, "--strict", help="Fail on warnings and verify referenced audio files exist on disk"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
):
    """Validate canonical sin-graph document topology and parameter constraints."""
    if not path.is_file():
        typer.secho(f"Error: File not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        typer.secho(f"Error reading JSON: {e}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    valid, errors = validate_graph(data)
    warnings = collect_graph_warnings(data) if valid else []

    missing_files: List[str] = []
    if valid and strict:
        for node in data.get("nodes", []):
            fpath = node.get("properties", {}).get("filepath")
            if fpath and not Path(fpath).is_file() and not (PROJECT_ROOT / fpath).is_file():
                missing_files.append(fpath)
        if missing_files:
            valid = False
            errors.append(f"Strict mode: {len(missing_files)} referenced audio file(s) do not exist on disk.")
        if warnings:
            valid = False
            errors.append(f"Strict mode: {len(warnings)} warning(s) treated as errors.")

    result = {
        "valid": valid,
        "path": str(path),
        "errors": errors,
        "warnings": warnings,
        "missing_files": missing_files,
    }

    if json_output:
        print(json.dumps(result, indent=2))
    else:
        if valid:
            typer.secho(f"[OK] Valid sin-graph: {path}", fg=typer.colors.GREEN, bold=True)
        else:
            typer.secho(f"[FAIL] Validation failed: {path}", fg=typer.colors.RED, bold=True)
            for err in errors:
                typer.echo(f"  - {err}")
        for warning in warnings:
            typer.secho(f"  [WARN] {warning}", fg=typer.colors.YELLOW)
    if not valid:
        raise typer.Exit(code=1)


@compose_app.command("info")
def compose_info(
    path: Path = typer.Argument(..., help="Path to sin-graph or workspace preset JSON"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
):
    """Inspect and summarize nodes, connections, buses, pools, and timings."""
    if not path.is_file():
        typer.secho(f"Error: File not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    is_canonical = data.get("format") == "sin-graph"
    if is_canonical:
        nodes = data.get("nodes", [])
        conns = data.get("connections", [])
        atts = data.get("attachments", [])
        settings = data.get("settings", {})
        bpm = settings.get("bpm", 120.0)
        bars = settings.get("total_bars", 4.0)
        key = settings.get("key", "C")
        output = data.get("output", "")
    else:
        graph = data.get("graph", {})
        nodes = graph.get("nodes", [])
        conns = graph.get("links", [])
        atts = []
        globals_p = graph.get("extra", {}).get("global_parameters", {})
        bpm = globals_p.get("bpm", 120.0)
        bars = globals_p.get("total_bars", 4.0)
        key = globals_p.get("key", "C")
        output = str(graph.get("extra", {}).get("main_preview", {}).get("node_id", ""))

    node_types: Dict[str, int] = {}
    for n in nodes:
        ntype = n.get("type", "unknown")
        node_types[ntype] = node_types.get(ntype, 0) + 1

    duration_seconds = (bars * 4.0 * 60.0) / bpm if bpm > 0 else 0.0

    info_dict = {
        "format": "sin-graph" if is_canonical else "workspace-preset",
        "path": str(path),
        "bpm": bpm,
        "total_bars": bars,
        "key": key,
        "estimated_duration_seconds": round(duration_seconds, 2),
        "total_nodes": len(nodes),
        "connections_count": len(conns),
        "attachments_count": len(atts),
        "node_breakdown": node_types,
        "output_node": output,
    }

    if json_output:
        print(json.dumps(info_dict, indent=2))
    else:
        typer.secho(f"Graph Summary: {path.name}", fg=typer.colors.CYAN, bold=True)
        typer.echo(f"  Format: {'Canonical sin-graph' if is_canonical else 'LiteGraph Workspace Preset'}")
        typer.echo(f"  BPM: {bpm} | Bars: {bars} | Key: {key} | Est. Duration: {duration_seconds:.1f}s")
        typer.echo(f"  Nodes: {len(nodes)} | Connections: {len(conns)} | Output: '{output}'")
        typer.echo("  Node Types:")
        for nt, count in sorted(node_types.items()):
            typer.echo(f"    - {nt}: {count}")


@compose_app.command("compile")
def compose_compile(
    path: Path = typer.Argument(..., help="Path to sin-graph or workspace preset JSON"),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="Save compiled AudioNodeModel JSON to file"),
    isolate: Optional[str] = typer.Option(None, "--isolate", "-i", help="Isolate subtree starting at node ID"),
):
    """Compile graph directly to canonical ERMES AudioNodeModel JSON."""
    if not path.is_file():
        typer.secho(f"Error: File not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    try:
        model = compile_any_to_audio_node_model(data, isolate_target=isolate)
        model_dict = model.model_dump() if hasattr(model, "model_dump") else model.dict()
        out_json = json.dumps(model_dict, indent=2)
        if out:
            out.write_text(out_json, encoding="utf-8")
            typer.secho(f"[OK] Compiled AudioNodeModel written to: {out}", fg=typer.colors.GREEN)
        else:
            print(out_json)
    except Exception as e:
        typer.secho(f"Compilation error: {e}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)


@compose_app.command("convert")
def compose_convert(
    path: Path = typer.Argument(..., help="Path to source graph JSON"),
    to: str = typer.Option("workspace", "--to", "-t", help="Target format: 'workspace' or 'canonical'"),
    out: Optional[Path] = typer.Option(None, "--out", "-o", help="Destination file path"),
):
    """Convert between canonical sin-graph and LiteGraph workspace presets with auto-layout."""
    if not path.is_file():
        typer.secho(f"Error: File not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if to.lower() in ("workspace", "preset", "litegraph"):
        if data.get("format") != "sin-graph":
            typer.secho("Error: Source is not a canonical sin-graph.", fg=typer.colors.RED, err=True)
            raise typer.Exit(code=1)
        converted = graph_to_workspace(data)
    else:
        typer.secho("Error: Conversion to canonical from workspace not yet configured.", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    formatted = json.dumps(converted, indent=2)
    if out:
        out.write_text(formatted, encoding="utf-8")
        typer.secho(f"[OK] Converted graph written to: {out} (Auto-layout applied)", fg=typer.colors.GREEN)
    else:
        print(formatted)


# ─────────────────────────────────────────────────────────────────────────────
# 4. LIBRARY SUBCOMMANDS
# ─────────────────────────────────────────────────────────────────────────────

@library_app.command("search")
def library_search(
    vault: Optional[str] = typer.Option(None, "--vault", help="Filter by vault storage key"),
    item_type: Optional[str] = typer.Option(None, "--type", "-t", help="Filter by type (sample, audio, track)"),
    tag: Optional[str] = typer.Option(None, "--tag", help="Filter by tag name (e.g. Kick, Snare, 808)"),
    bpm_min: Optional[float] = typer.Option(None, "--bpm-min", help="Minimum BPM"),
    bpm_max: Optional[float] = typer.Option(None, "--bpm-max", help="Maximum BPM"),
    key: Optional[str] = typer.Option(None, "--key", help="Filter by root key"),
    limit: int = typer.Option(20, "--limit", "-l", help="Maximum results to return"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
):
    """Query GAIA library assets in read-only mode."""
    db_path = _get_gaia_db()
    if not db_path:
        typer.secho("Error: gaia.db not found.", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    query = """
        SELECT i.id, i.absolute_path, i.type, v.storage_key as vault, s.bpm, s.key
        FROM items i
        LEFT JOIN vaults v ON i.vault_id = v.id
        LEFT JOIN sample_items s ON i.id = s.id
        WHERE 1=1
    """
    params: List[Any] = []

    if vault:
        query += " AND v.storage_key = ?"
        params.append(vault)
    if item_type:
        query += " AND i.type = ?"
        params.append(item_type)
    if bpm_min is not None:
        query += " AND s.bpm >= ?"
        params.append(bpm_min)
    if bpm_max is not None:
        query += " AND s.bpm <= ?"
        params.append(bpm_max)
    if key:
        query += " AND s.key = ?"
        params.append(key)
    if tag:
        query += """
            AND i.id IN (
                SELECT it.item_id FROM item_tags it
                JOIN tags t ON it.tag_id = t.id
                WHERE LOWER(t.name) = LOWER(?)
            )
        """
        params.append(tag)

    query += " ORDER BY i.id LIMIT ?"
    params.append(limit)

    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()

    results = [
        {
            "id": r["id"],
            "name": Path(r["absolute_path"]).name if r["absolute_path"] else f"Item {r['id']}",
            "type": r["type"],
            "vault": r["vault"],
            "bpm": r["bpm"],
            "key": r["key"],
            "path": r["absolute_path"],
        }
        for r in rows
    ]

    if json_output:
        print(json.dumps(results, indent=2))
    else:
        typer.secho(f"Found {len(results)} item(s) in GAIA library:", fg=typer.colors.CYAN, bold=True)
        for item in results:
            bpm_str = f"{item['bpm']} BPM" if item['bpm'] else "--"
            key_str = f"Key: {item['key']}" if item['key'] else ""
            typer.echo(f"  [{item['id']:4d}] {item['name']:<30} | {item['type']:<8} | {bpm_str:<8} | {key_str}")


@library_app.command("verify")
def library_verify(
    path: Path = typer.Argument(..., help="Path to sin-graph or workspace preset JSON"),
    json_output: bool = typer.Option(False, "--json", help="Emit machine-readable JSON"),
):
    """Verify that all asset IDs and locators inside a graph exist on disk."""
    if not path.is_file():
        typer.secho(f"Error: File not found: {path}", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    db_path = _get_gaia_db()
    db_items: Dict[int, Dict[str, Any]] = {}
    if db_path:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        for row in conn.execute("SELECT id, absolute_path FROM items"):
            name = Path(row["absolute_path"]).name if row["absolute_path"] else f"Item {row['id']}"
            db_items[row["id"]] = {"name": name, "path": row["absolute_path"]}
        conn.close()

    checked_locators: List[Dict[str, Any]] = []
    missing_locators: List[Dict[str, Any]] = []

    # Inspect nodes
    nodes = data.get("nodes", []) if data.get("format") == "sin-graph" else data.get("graph", {}).get("nodes", [])
    for n in nodes:
        props = n.get("properties", {})
        # Check direct filepath
        fpath = props.get("filepath")
        if fpath:
            exists = Path(fpath).is_file() or (PROJECT_ROOT / fpath).is_file()
            loc_record = {"node": n.get("name") or n.get("title"), "path": fpath, "exists": exists}
            checked_locators.append(loc_record)
            if not exists:
                missing_locators.append(loc_record)

        # Check asset pool items
        items_list = props.get("selected_items", [])
        for item in items_list:
            item_id = item.get("id") if isinstance(item, dict) else item
            if item_id in db_items:
                disk_path = db_items[item_id]["path"]
                exists = Path(disk_path).is_file() or (PROJECT_ROOT / disk_path).is_file()
                rec = {"node": n.get("name") or n.get("title"), "id": item_id, "name": db_items[item_id]["name"], "path": disk_path, "exists": exists}
            else:
                rec = {"node": n.get("name") or n.get("title"), "id": item_id, "exists": False, "missing_in_db": True}
            checked_locators.append(rec)
            if not rec.get("exists"):
                missing_locators.append(rec)

    is_verified = len(missing_locators) == 0
    report = {
        "verified": is_verified,
        "path": str(path),
        "total_references": len(checked_locators),
        "missing_references": missing_locators,
    }

    if json_output:
        print(json.dumps(report, indent=2))
    else:
        if is_verified:
            typer.secho(f"[OK] All {len(checked_locators)} referenced asset locators verified on disk: {path.name}", fg=typer.colors.GREEN, bold=True)
        else:
            typer.secho(f"[FAIL] Found {len(missing_locators)} missing asset locators: {path.name}", fg=typer.colors.RED, bold=True)
            for m in missing_locators[:10]:
                typer.echo(f"  - [{m.get('id', 'N/A')}] {m.get('path', 'Unknown path')}")
    if not is_verified:
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
