#!/usr/bin/env bash
# Build IRIDE, then start IRIDE with its API and the GAIA library manager.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RELOAD=false
for arg in "$@"; do
  case "$arg" in
    --no-reload)
      RELOAD=false
      ;;
    --reload)
      RELOAD=true
      ;;
  esac
done

resolve_python() {
  local candidate
  local candidates=(
    "$ROOT_DIR/.venv/Scripts/python.exe"
    "$ROOT_DIR/.venv/bin/python"
  )

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    if "$candidate" -c 'import pathlib, sys; expected = pathlib.Path(sys.argv[1]).resolve(); actual = pathlib.Path(sys.prefix).resolve(); raise SystemExit(0 if actual == expected else 1)' "$ROOT_DIR/.venv" >/dev/null 2>&1 \
      && "$candidate" -c "import fastapi, uvicorn, librosa, soundfile, pyrubberband, mutagen, sqlalchemy" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "The project .venv is missing, stale, or does not contain all backend requirements." >&2
  echo "Repair .venv before launching; the launcher will not fall back to another Python." >&2
  return 1
}

PYTHON_CMD="$(resolve_python)"
export VIRTUAL_ENV="$ROOT_DIR/.venv"
export PYTHONNOUSERSITE=1
unset PYTHONHOME

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to start the Vite frontend." >&2
  exit 1
fi

FRONTEND_DIR="iride"

if [[ ! -d "$ROOT_DIR/$FRONTEND_DIR/node_modules" ]]; then
  echo "IRIDE frontend dependencies are missing. Run: npm --prefix $FRONTEND_DIR install" >&2
  exit 1
fi

echo "Building IRIDE for http://127.0.0.1:8000..."
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
  echo "Stopping development servers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait "${PIDS[@]}" 2>/dev/null || true
}

trap stop_servers EXIT INT TERM

if [[ "$RELOAD" == "true" ]]; then
  echo "Hot reload: ENABLED"
  start_server "IRIDE on http://127.0.0.1:8000" "$PYTHON_CMD" run.py
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001 --reload
  start_server "IRIDE frontend build watcher" npm --prefix "$FRONTEND_DIR" run build:watch
else
  echo "Hot reload: DISABLED"
  start_server "IRIDE on http://127.0.0.1:8000" "$PYTHON_CMD" run.py --no-reload
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001
fi

echo
echo "All development servers are starting:"
echo "  IRIDE + API:  http://127.0.0.1:8000"
echo "  GAIA Manager: http://127.0.0.1:8001"
echo "Press Ctrl+C to stop them all."

wait
