#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

kill_if_running () {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" || true)"
    if [[ -n "${pid}" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
}

kill_if_running "$ROOT_DIR/.online-cloudflared.pid"
kill_if_running "$ROOT_DIR/.online-gateway.pid"

echo "Stopped (if running)."
echo "Passkey file (kept): $ROOT_DIR/.online-passkey"
