#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PORT="${PORT:-8765}"

cd "${SCRIPT_DIR}"
if [[ -x "${REPO_ROOT}/.venv/bin/python" ]]; then
  exec "${REPO_ROOT}/.venv/bin/python" "${SCRIPT_DIR}/server.py" --port "${PORT}" "$@"
else
  exec python3 "${SCRIPT_DIR}/server.py" --port "${PORT}" "$@"
fi
