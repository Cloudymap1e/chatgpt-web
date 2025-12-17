import json
import os
import re
import time
import secrets
from pathlib import Path
from lorem_text import lorem

from fastapi import FastAPI
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import Response, StreamingResponse, HTMLResponse, RedirectResponse
from starlette.responses import FileResponse

app = FastAPI()

# Optional passkey auth (recommended when exposing publicly)
APP_PASSKEY = os.environ.get("APP_PASSKEY", "")
MODE = os.environ.get("MODE", "mock").strip().lower()
UPSTREAM_BASE = os.environ.get("UPSTREAM_BASE", "https://api.openai.com").rstrip("/")
OPENAI_API_KEY = (os.environ.get("OPENAI_API_KEY", "") or os.environ.get("VITE_OPENAI_API_KEY", "")).strip()
STATIC_DIR = Path(os.environ.get("STATIC_DIR", "/work/dist")).resolve()

# CORS: by default allow any origin (legacy behavior). If you're using cookies (sessions),
# set CORS_ALLOW_ORIGINS to a comma-separated list and CORS_ALLOW_CREDENTIALS=1.
CORS_ALLOW_ORIGINS = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
CORS_ALLOW_CREDENTIALS = os.environ.get("CORS_ALLOW_CREDENTIALS", "").strip() in ("1", "true", "yes", "on")

if CORS_ALLOW_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ALLOW_ORIGINS,
        allow_credentials=CORS_ALLOW_CREDENTIALS,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

if APP_PASSKEY:
    # Prefer a dedicated secret if provided, else derive from the passkey.
    session_secret = os.environ.get("SESSION_SECRET", "").strip() or APP_PASSKEY
    app.add_middleware(
        SessionMiddleware,
        secret_key=session_secret,
        same_site="lax",
        https_only=os.environ.get("HTTPS_ONLY", "").strip() in ("1", "true", "yes", "on"),
    )

MOCK_UPSTREAM_BASE = os.environ.get("MOCK_API_UPSTREAM", "").rstrip("/")

_login_attempts: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW_S = 60.0
_LOGIN_MAX_PER_WINDOW = int(os.environ.get("LOGIN_MAX_PER_MIN", "12"))


def _client_ip(request: Request) -> str:
    return (request.client.host if request.client else "unknown") or "unknown"


def _is_authed(request: Request) -> bool:
    if not APP_PASSKEY:
        return True
    try:
        return bool(request.session.get("authed"))
    except Exception:
        return False


def _require_auth_or_401(request: Request) -> Response | None:
    if _is_authed(request):
        return None
    return Response(
        content=json.dumps({"error": "unauthorized"}),
        status_code=401,
        media_type="application/json",
    )


def _require_auth_or_redirect(request: Request) -> Response | None:
    if _is_authed(request):
        return None
    return RedirectResponse(url="/login", status_code=302)

def _filter_hop_by_hop_headers(headers: dict) -> dict:
    # https://www.rfc-editor.org/rfc/rfc2616#section-13.5.1
    hop_by_hop = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
    return {k: v for k, v in headers.items() if k.lower() not in hop_by_hop}


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if not APP_PASSKEY:
        return HTMLResponse(
            "<h3>APP_PASSKEY is not set</h3><p>Set APP_PASSKEY to enable login protection.</p>",
            status_code=500,
        )
    if _is_authed(request):
        return RedirectResponse(url="/", status_code=302)
    return HTMLResponse(
        """
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Login</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 520px; margin: 10vh auto; padding: 0 16px; }
      input, button { font-size: 16px; padding: 10px 12px; width: 100%; box-sizing: border-box; }
      button { margin-top: 12px; cursor: pointer; }
      .err { color: #b00020; margin-top: 10px; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h2>API2Web</h2>
    <p>Enter passkey to continue.</p>
    <input id="passkey" type="password" autocomplete="current-password" placeholder="Passkey" />
    <button id="btn">Login</button>
    <div id="err" class="err"></div>
    <script>
      const pass = document.getElementById('passkey');
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      async function submit() {
        err.textContent = '';
        const passkey = pass.value || '';
        try {
          const r = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ passkey })
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data?.error || ('HTTP ' + r.status));
          location.href = '/';
        } catch (e) {
          err.textContent = String(e?.message || e);
        }
      }
      btn.addEventListener('click', submit);
      pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      pass.focus();
    </script>
  </body>
</html>
        """.strip(),
        status_code=200,
    )


@app.post("/auth/login")
async def login_api(request: Request):
    if not APP_PASSKEY:
        return Response(
            content=json.dumps({"error": "APP_PASSKEY is not set"}),
            status_code=500,
            media_type="application/json",
        )

    ip = _client_ip(request)
    now = time.time()
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if (now - t) <= _RATE_LIMIT_WINDOW_S]
    if len(attempts) >= _LOGIN_MAX_PER_WINDOW:
        _login_attempts[ip] = attempts
        return Response(
            content=json.dumps({"error": "too many attempts, try again later"}),
            status_code=429,
            media_type="application/json",
        )
    attempts.append(now)
    _login_attempts[ip] = attempts

    data = await request.json()
    passkey = (data.get("passkey") or "").strip()
    if not secrets.compare_digest(passkey, APP_PASSKEY):
        return Response(
            content=json.dumps({"error": "invalid passkey"}),
            status_code=401,
            media_type="application/json",
        )

    request.session["authed"] = True
    return {"ok": True}


@app.post("/auth/logout")
async def logout_api(request: Request):
    try:
        request.session.clear()
    except Exception:
        pass
    return {"ok": True}


@app.get("/")
async def root(request: Request):
    guard = _require_auth_or_redirect(request)
    if guard:
        return guard
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return HTMLResponse(
        "<h3>dist/ not found</h3><p>Run <code>npm run build</code> so this server can serve the SPA.</p>",
        status_code=500,
    )


if MODE == "proxy":
    @app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    async def proxy_openai_v1(path: str, request: Request):
        guard = _require_auth_or_401(request)
        if guard:
            return guard

        upstream_url = f"{UPSTREAM_BASE}/v1/{path.lstrip('/')}"
        if request.url.query:
            upstream_url += f"?{request.url.query}"

        import httpx

        body = await request.body()
        headers = _filter_hop_by_hop_headers(dict(request.headers))

        # Ensure upstream auth is server-controlled if configured.
        if OPENAI_API_KEY:
            headers["authorization"] = f"Bearer {OPENAI_API_KEY}"

        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            upstream_resp = await client.request(
                request.method,
                upstream_url,
                headers=headers,
                content=body,
            )

            resp_headers = _filter_hop_by_hop_headers(dict(upstream_resp.headers))
            content_type = upstream_resp.headers.get("content-type", "")
            if content_type.startswith("text/event-stream"):
                return StreamingResponse(
                    upstream_resp.aiter_raw(),
                    status_code=upstream_resp.status_code,
                    headers=resp_headers,
                    media_type=content_type,
                )

            return Response(
                content=upstream_resp.content,
                status_code=upstream_resp.status_code,
                headers=resp_headers,
                media_type=content_type or None,
            )


@app.api_route("/proxy/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy(path: str, request: Request):
    """
    Simple upstream proxy (useful for local dev when the upstream does not allow browser CORS).

    Configure with env var:
      MOCK_API_UPSTREAM=https://right.codes/codex
    Then call from the SPA:
      API BASE URI = http://<this-host>:5174/proxy
    """
    guard = _require_auth_or_401(request)
    if guard:
        return guard

    if not MOCK_UPSTREAM_BASE:
        return Response(
            content=json.dumps({"error": "MOCK_API_UPSTREAM is not set"}),
            status_code=500,
            media_type="application/json",
        )

    upstream_url = f"{MOCK_UPSTREAM_BASE}/{path.lstrip('/')}"
    if request.url.query:
        upstream_url += f"?{request.url.query}"

    # Import here so the app still runs if proxy isn't used.
    import httpx

    body = await request.body()
    headers = _filter_hop_by_hop_headers(dict(request.headers))

    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        upstream_resp = await client.request(
            request.method,
            upstream_url,
            headers=headers,
            content=body,
        )

        resp_headers = _filter_hop_by_hop_headers(dict(upstream_resp.headers))
        content_type = upstream_resp.headers.get("content-type", "")
        if content_type.startswith("text/event-stream"):
            return StreamingResponse(
                upstream_resp.aiter_raw(),
                status_code=upstream_resp.status_code,
                headers=resp_headers,
                media_type=content_type,
            )

        return Response(
            content=upstream_resp.content,
            status_code=upstream_resp.status_code,
            headers=resp_headers,
            media_type=content_type or None,
        )


# Define a route to handle POST requests
@app.post("/v1/chat/completions")
async def post_data(data: dict):
    """Returns mock responses for testing purposes."""

    messages = data['messages']
    instructions = messages[-1]['content']

    delay = 0
    lines = None
    answer = 'Default mock answer from mocked API'

    try:
        delay = re.findall(r'(?<=d)\d+',instructions)[0]
    except:
        pass

    try:
        lines = re.findall(r'(?<=l)\d+',instructions)[0]
    except:
        pass


    if delay:
        time.sleep(int(delay))

    if lines:
        answer = "\n".join([lorem.sentence() for _ in range(int(lines))])

    response = {
        "id": 0,
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"content": answer,"role": "assistant"}
        }]
    }
    return response


@app.post("/v1/responses")
async def post_responses(data: dict):
    """Returns mock Responses API output for testing purposes."""
    # Accept both Chat Completions-like and Responses-like payloads (best-effort)
    input_messages = data.get('input') or []
    if isinstance(input_messages, str):
        instructions = input_messages
    elif isinstance(input_messages, list) and input_messages:
        last = input_messages[-1] or {}
        content = last.get('content')
        if isinstance(content, str):
            instructions = content
        elif isinstance(content, list) and content:
            # [{type:'input_text', text:'...'}]
            instructions = (content[-1] or {}).get('text') or ''
        else:
            instructions = ''
    else:
        # fallback to chat.completions schema
        messages = data.get('messages') or []
        instructions = (messages[-1] or {}).get('content') if messages else ''

    delay = 0
    lines = None
    answer = 'Default mock answer from mocked API'

    try:
        delay = re.findall(r'(?<=d)\\d+', instructions)[0]
    except:
        pass

    try:
        lines = re.findall(r'(?<=l)\\d+', instructions)[0]
    except:
        pass

    if delay:
        time.sleep(int(delay))

    if lines:
        answer = "\\n".join([lorem.sentence() for _ in range(int(lines))])

    response = {
        "id": 0,
        "model": data.get("model", ""),
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": answer}
                ],
            }
        ],
        "usage": {"input_tokens": 0, "output_tokens": 1, "total_tokens": 1},
    }
    return response


@app.get('/v1/models')
async def list_models():
    """Returns a list of models to get app to work."""
    with open('/work/models_response.json') as f:
        result = json.load(f)

    return result


@app.post('/')
async def post_data(data: dict):
    """Basic route for testing the API works"""
    result = {"message": "Data received", "data": data}
    return result


@app.get("/{path:path}")
async def spa_fallback(path: str, request: Request):
    """
    SPA fallback: serve files from dist/ if present, else index.html.
    Registered last so it doesn't shadow API routes.
    """
    # Don't intercept API/auth routes
    if (
        path.startswith("v1/")
        or path == "v1"
        or path.startswith("auth/")
        or path == "login"
        or path.startswith("proxy/")
    ):
        return Response(status_code=404)

    guard = _require_auth_or_redirect(request)
    if guard:
        return guard

    candidate = (STATIC_DIR / path).resolve()
    if STATIC_DIR in candidate.parents and candidate.is_file():
        return FileResponse(candidate)

    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return Response(status_code=404)
