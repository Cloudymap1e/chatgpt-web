#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-5174}"
HOST="${HOST:-127.0.0.1}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found. Install it first, then rerun."
  exit 1
fi

GATEWAY_PID_FILE="${ROOT_DIR}/.online-gateway.pid"
CLOUDFLARED_PID_FILE="${ROOT_DIR}/.online-cloudflared.pid"

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

# If a previous run is still up, stop it so we don't end up with a mismatched passkey.
kill_if_running "$CLOUDFLARED_PID_FILE"
kill_if_running "$GATEWAY_PID_FILE"

# If something is already bound to the port (e.g. a previous run that didn't write PID files),
# kill it so we don't end up tunneling the wrong process/passkey.
existing_pids="$(
  ss -ltnp 2>/dev/null \
    | grep -E ":${PORT}\\b" \
    | grep -Eo "pid=[0-9]+" \
    | cut -d= -f2 \
    | sort -u \
    || true
)"
if [[ -n "${existing_pids}" ]]; then
  echo "Port ${PORT} already in use; stopping existing PID(s): ${existing_pids}"
  for pid in ${existing_pids}; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  sleep 0.5
fi

APP_PASSKEY="${APP_PASSKEY:-}"
PASSKEY_FILE="${ROOT_DIR}/.online-passkey"

if [[ -z "${APP_PASSKEY}" && -f "$PASSKEY_FILE" ]]; then
  APP_PASSKEY="$(tr -d '\r\n' < "$PASSKEY_FILE")"
fi

if [[ -z "${APP_PASSKEY}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    APP_PASSKEY="$(openssl rand -base64 48 | tr -d '\n')"
  else
    APP_PASSKEY="$(node -e "process.stdout.write(require('crypto').randomBytes(36).toString('base64url'))")"
  fi
  printf "%s" "$APP_PASSKEY" > "$PASSKEY_FILE"
  echo "Generated APP_PASSKEY:"
  echo "$APP_PASSKEY"
  echo
else
  # Persist for reuse so restarts don't change the login passkey unless you override APP_PASSKEY.
  printf "%s" "$APP_PASSKEY" > "$PASSKEY_FILE"
fi

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_API_KEY_SOURCE="env"

extract_sk_token () {
  # Extract last sk- token from any input (handles accidental newlines or extra text).
  # shellcheck disable=SC2001
  printf "%s" "$1" | grep -Eo 'sk-[A-Za-z0-9]+' 2>/dev/null | tail -n 1 || true
}

if [[ -n "${OPENAI_API_KEY}" ]]; then
  tok="$(extract_sk_token "$OPENAI_API_KEY")"
  if [[ -n "$tok" ]]; then
    OPENAI_API_KEY="$tok"
  fi
fi

if [[ -z "${OPENAI_API_KEY}" && -f "$ROOT_DIR/../api.key" ]]; then
  OPENAI_API_KEY="$(extract_sk_token "$(cat "$ROOT_DIR/../api.key")")"
  OPENAI_API_KEY_SOURCE="../api.key"
fi
if [[ -z "${OPENAI_API_KEY}" ]]; then
  echo "OPENAI_API_KEY is not set (and ../api.key not found)."
  echo "Set it like: OPENAI_API_KEY='sk-...' APP_PASSKEY='...' $0"
  exit 1
fi
echo "Using OPENAI_API_KEY from: $OPENAI_API_KEY_SOURCE"

export VITE_SERVER_API_KEY="${VITE_SERVER_API_KEY:-1}"
export VITE_HIDE_API_KEY_INPUT="${VITE_HIDE_API_KEY_INPUT:-1}"
# Limit model dropdown to newest models unless you override it.
# Example override: VITE_MODEL_ALLOWLIST="gpt-5,gpt-5.2,gpt-5-codex"
export VITE_MODEL_ALLOWLIST="${VITE_MODEL_ALLOWLIST:-gpt-5,gpt-5.2}"

echo "Building UI..."
npm run build >/dev/null

GATEWAY_LOG="${ROOT_DIR}/.online-gateway.log"
CLOUDFLARED_LOG="${ROOT_DIR}/.online-cloudflared.log"

echo "Starting gateway on ${HOST}:${PORT}..."
GATEWAY_HTTPS_PROXY="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
if [[ -z "$GATEWAY_HTTPS_PROXY" && "${UPSTREAM_BASE:-}" == "https://api.openai.com" && "${NO_GATEWAY_PROXY:-0}" != "1" ]]; then
  # Default to local Clash proxy port; required on many networks for api.openai.com.
  GATEWAY_HTTPS_PROXY="http://127.0.0.1:7890"
  echo "Using outbound proxy for gateway: $GATEWAY_HTTPS_PROXY (set NO_GATEWAY_PROXY=1 to disable)"
fi
nohup env \
  PORT="$PORT" HOST="$HOST" \
  APP_PASSKEY="$APP_PASSKEY" MODE="${MODE:-proxy}" \
  OPENAI_API_KEY="$OPENAI_API_KEY" \
  HTTPS_PROXY="$GATEWAY_HTTPS_PROXY" HTTP_PROXY="$GATEWAY_HTTPS_PROXY" \
  node gateway/server.mjs >"$GATEWAY_LOG" 2>&1 &
echo $! >"$GATEWAY_PID_FILE"

echo "Starting cloudflared tunnel..."
# QUIC can be blocked/unreliable on some networks; default to http2 for stability.
CLOUDFLARED_PROTOCOL="${CLOUDFLARED_PROTOCOL:-http2}"
nohup cloudflared tunnel --url "http://${HOST}:${PORT}" --protocol "$CLOUDFLARED_PROTOCOL" --no-autoupdate >"$CLOUDFLARED_LOG" 2>&1 &
echo $! >"$CLOUDFLARED_PID_FILE"

echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for _ in $(seq 1 60); do
  if command -v rg >/dev/null 2>&1; then
    TUNNEL_URL="$(rg -o "https://[a-zA-Z0-9-]+\\.trycloudflare\\.com" "$CLOUDFLARED_LOG" | tail -n 1 || true)"
  else
    TUNNEL_URL="$(grep -Eo "https://[A-Za-z0-9-]+\\.trycloudflare\\.com" "$CLOUDFLARED_LOG" 2>/dev/null | tail -n 1 || true)"
  fi
  if [[ -n "$TUNNEL_URL" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Couldn't detect a trycloudflare URL yet."
  echo "Check logs: $CLOUDFLARED_LOG"
  exit 1
fi

echo
echo "Online URL:"
echo "$TUNNEL_URL"
echo
echo "Login passkey:"
echo "$APP_PASSKEY"
echo
echo "To stop:"
echo "  $ROOT_DIR/scripts/online-down.sh"
