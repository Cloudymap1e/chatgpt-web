#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v rg >/dev/null 2>&1; then
  URL="$(rg -o "https://[a-zA-Z0-9-]+\\.trycloudflare\\.com" "$ROOT_DIR/.online-cloudflared.log" 2>/dev/null | tail -n 1 || true)"
else
  URL="$(grep -Eo "https://[A-Za-z0-9-]+\\.trycloudflare\\.com" "$ROOT_DIR/.online-cloudflared.log" 2>/dev/null | tail -n 1 || true)"
fi
PASSKEY="$(cat "$ROOT_DIR/.online-passkey" 2>/dev/null || true)"

if [[ -z "${URL}" || -z "${PASSKEY}" ]]; then
  echo "No active tunnel/passkey found. Starting..."
  "$ROOT_DIR/scripts/online-up.sh" >/dev/null
  if command -v rg >/dev/null 2>&1; then
    URL="$(rg -o "https://[a-zA-Z0-9-]+\\.trycloudflare\\.com" "$ROOT_DIR/.online-cloudflared.log" | tail -n 1 || true)"
  else
    URL="$(grep -Eo "https://[A-Za-z0-9-]+\\.trycloudflare\\.com" "$ROOT_DIR/.online-cloudflared.log" 2>/dev/null | tail -n 1 || true)"
  fi
  PASSKEY="$(cat "$ROOT_DIR/.online-passkey" 2>/dev/null || true)"
fi

if [[ -z "${URL}" ]]; then
  echo "Tunnel URL not found. Check: $ROOT_DIR/.online-cloudflared.log"
  exit 1
fi
if [[ -z "${PASSKEY}" ]]; then
  echo "Passkey not found. Check: $ROOT_DIR/.online-passkey"
  exit 1
fi

echo "Tunnel: $URL"

tmp_headers="$(mktemp)"
tmp_cookie="$(mktemp)"
cleanup () { rm -f "$tmp_headers" "$tmp_cookie"; }
trap cleanup EXIT

echo "1) Login..."
curl -fsS -D "$tmp_headers" -o /dev/null \
  -X POST "$URL/auth/login" \
  -H 'content-type: application/json' \
  --data-binary "{\"passkey\":\"$PASSKEY\"}"

cookie="$(rg -i '^set-cookie:' "$tmp_headers" | head -n 1 | sed -E 's/^set-cookie:[[:space:]]*//' | cut -d';' -f1 || true)"
if [[ -z "${cookie}" ]]; then
  echo "Login did not return a cookie. Headers:"
  cat "$tmp_headers"
  exit 1
fi
printf "%s" "$cookie" > "$tmp_cookie"
echo "   ok"

echo "2) Fetch UI (authenticated)..."
curl -fsS -o /dev/null -H "cookie: $cookie" "$URL/"
echo "   ok"

echo "3) Call /v1/models (authenticated)..."
tmp_body="$(mktemp)"
http_code="$(curl -sS -o "$tmp_body" -w '%{http_code}' -H "cookie: $cookie" "$URL/v1/models" || true)"
if [[ "$http_code" != "200" ]]; then
  echo "   FAIL (HTTP $http_code). Body:"
  head -c 400 "$tmp_body" || true
  echo
  echo "   Check gateway log: $ROOT_DIR/.online-gateway.log"
  rm -f "$tmp_body"
  exit 1
fi
rm -f "$tmp_body"
echo "   ok"

echo "PASS"
