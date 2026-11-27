#!/usr/bin/env bash
# Single macOS / Unix entry point for SIN (:8000) and GAIA (:8001).
# Automatically builds native libsin_dsp.dylib (CoreAudio) if missing, builds SIN,
# and starts both services cleanly with Ctrl+C teardown.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RELOAD=false
REBUILD_ENGINE=false
STOP_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --reload)
      RELOAD=true
      ;;
    --no-reload)
      RELOAD=false
      ;;
    --rebuild-engine)
      REBUILD_ENGINE=true
      ;;
    --stop)
      STOP_ONLY=true
      ;;
  esac
done

stop_stale_port() {
  local port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && return 0
  for pid in $pids; do
    local cmd
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$cmd" == *"run.py"* || "$cmd" == *"gaia.main:app"* || "$cmd" == *"uvicorn"* ]]; then
      echo "Stopping previous SIN/GAIA process on port $port (PID $pid)..."
      kill "$pid" 2>/dev/null || true
    else
      echo "Port $port is in use by another process (PID $pid: $cmd)." >&2
      exit 1
    fi
  done
  sleep 0.4
}

stop_stale_port 8000
stop_stale_port 8001
if [[ "$STOP_ONLY" == "true" ]]; then
  echo "Stopped any running SIN (:8000) and GAIA (:8001) servers."
  exit 0
fi

resolve_python() {
  local candidate
  local candidates=(
    "$ROOT_DIR/.venv/bin/python"
    "$ROOT_DIR/.venv/Scripts/python.exe"
  )

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    if "$candidate" -c 'import pathlib, sys; expected = pathlib.Path(sys.argv[1]).resolve(); actual = pathlib.Path(sys.prefix).resolve(); raise SystemExit(0 if actual == expected else 1)' "$ROOT_DIR/.venv" >/dev/null 2>&1 \
      && "$candidate" -c "import fastapi, uvicorn, websockets, librosa, soundfile, pyrubberband, mutagen, sqlalchemy" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "The project .venv is missing, stale, or missing backend requirements." >&2
  echo "Run: .venv/bin/python -m pip install -r requirements.txt" >&2
  return 1
}

ensure_native_audio_engine() {
  local lib_path="$ROOT_DIR/engine/bin/libsin_dsp.dylib"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    lib_path="$ROOT_DIR/engine/bin/libsin_dsp.so"
  fi
  local needs_build=false
  if [[ "$REBUILD_ENGINE" == "true" || ! -f "$lib_path" ]]; then
    needs_build=true
  elif [[ -n "$(find "$ROOT_DIR/engine/include" "$ROOT_DIR/engine/src" "$ROOT_DIR/dsp_modules/include" -type f -newer "$lib_path" 2>/dev/null)" ]]; then
    needs_build=true
  fi

  if [[ "$needs_build" == "true" && -f "$ROOT_DIR/tools/build-engine.sh" ]]; then
    echo "Building native real-time C++ audio engine ($lib_path)..."
    if ! bash "$ROOT_DIR/tools/build-engine.sh"; then
      echo "Warning: Could not build native libsin_dsp; falling back to offline Python previews." >&2
    fi
  fi
}

PYTHON_CMD="$(resolve_python)"
export VIRTUAL_ENV="$ROOT_DIR/.venv"
export PYTHONNOUSERSITE=1
unset PYTHONHOME

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to start the SIN frontend." >&2
  exit 1
fi

FRONTEND_DIR="editor"
if [[ ! -d "$ROOT_DIR/$FRONTEND_DIR/node_modules" ]]; then
  echo "SIN frontend dependencies are missing. Run: npm --prefix $FRONTEND_DIR install" >&2
  exit 1
fi

ensure_native_audio_engine

echo "Building SIN for http://127.0.0.1:8000..."
npm --silent --prefix "$FRONTEND_DIR" run build -- --logLevel error

PIDS=()

start_server() {
  local name="$1"
  shift
  echo "Starting $name..."
  "$@" &
  PIDS+=("$!")
}

stop_servers() {
  local pid
  trap - EXIT INT TERM
  echo
  echo "Stopping SIN and GAIA..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${PIDS[@]}" 2>/dev/null || true
}

trap stop_servers EXIT INT TERM

if [[ "$RELOAD" == "true" ]]; then
  echo "Hot reload: ENABLED"
  start_server "SIN on http://127.0.0.1:8000" "$PYTHON_CMD" run.py
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001 --reload
  start_server "SIN frontend build watcher" npm --prefix "$FRONTEND_DIR" run build:watch
else
  echo "Hot reload: DISABLED"
  start_server "SIN on http://127.0.0.1:8000" "$PYTHON_CMD" run.py --no-reload
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001
fi

echo
echo "All development servers are starting:"
echo "  SIN + API:    http://127.0.0.1:8000"
echo "  GAIA Manager: http://127.0.0.1:8001"
echo "Press Ctrl+C to stop them all."

wait
