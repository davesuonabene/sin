#!/usr/bin/env bash
# Start the Beat Generator API, GAIA Library, and Vite development server with hot reload enabled.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

RELOAD=true
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
    "${PYTHON_BIN:-}"
    "$ROOT_DIR/.venv/Scripts/python.exe"
    "$ROOT_DIR/.venv/bin/python"
    "python"
    "python3"
  )

  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" ]] || continue
    if "$candidate" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  echo "No Python environment with FastAPI and Uvicorn was found." >&2
  echo "Create/install the project environment, or set PYTHON_BIN to its Python executable." >&2
  return 1
}

PYTHON_CMD="$(resolve_python)"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to start the Vite frontend." >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
  echo "Frontend dependencies are missing. Run: npm --prefix frontend install" >&2
  exit 1
fi

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
  start_server "main API on http://127.0.0.1:8000" "$PYTHON_CMD" run.py
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001 --reload
else
  echo "Hot reload: DISABLED"
  start_server "main API on http://127.0.0.1:8000" "$PYTHON_CMD" run.py --no-reload
  start_server "GAIA Library on http://127.0.0.1:8001" "$PYTHON_CMD" -m uvicorn gaia.main:app --host 127.0.0.1 --port 8001
fi

start_server "Vite frontend on http://127.0.0.1:5173" npm --prefix frontend run dev -- --host 127.0.0.1

echo
echo "All development servers are starting:"
echo "  Main app:  http://127.0.0.1:8000"
echo "  GAIA:      http://127.0.0.1:8001"
echo "  Frontend:  http://127.0.0.1:5173"
echo "Press Ctrl+C to stop them all."

wait
