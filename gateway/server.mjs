import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import dns from 'node:dns'
import { createRequire } from 'node:module'

const PORT = Number.parseInt(process.env.PORT || '5174', 10)
const HOST = process.env.HOST || '0.0.0.0'

// Avoid IPv6-first resolution issues in some networks (manifests as connect timeouts in undici/fetch).
try {
  dns.setDefaultResultOrder('ipv4first')
} catch {
  // ignore (older Node)
}

const APP_PASSKEY = (process.env.APP_PASSKEY || '').trim()
const COOKIE_NAME = process.env.COOKIE_NAME || 'api2web_session'
const COOKIE_SECRET = (process.env.COOKIE_SECRET || process.env.SESSION_SECRET || APP_PASSKEY || 'dev').trim()
const MODE = (process.env.MODE || 'proxy').trim().toLowerCase() // proxy | static
// Default to the project's OpenAI-compatible upstream used earlier in this repo.
// This should expose OpenAI-style routes at `${UPSTREAM_BASE}/v1/*`.
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://right.codes/codex').replace(/\/$/, '')
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '').trim()

const STATIC_DIR = resolve(process.env.STATIC_DIR || join(process.cwd(), 'dist'))

// Optional outbound proxy for environments where the upstream is blocked.
// Example: HTTPS_PROXY=http://127.0.0.1:7890
const OUTBOUND_PROXY = (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim()
if (OUTBOUND_PROXY) {
  try {
    const require = createRequire(import.meta.url)
    const { ProxyAgent, setGlobalDispatcher } = require('undici')
    setGlobalDispatcher(new ProxyAgent(OUTBOUND_PROXY))
    // eslint-disable-next-line no-console
    console.log(`Using outbound proxy: ${OUTBOUND_PROXY}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to enable outbound proxy (${OUTBOUND_PROXY}): ${err?.message || err}`)
  }
}

const sessions = new Map() // token -> { exp:number }
const SESSION_TTL_MS = Number.parseInt(process.env.SESSION_TTL_MS || String(24 * 60 * 60 * 1000), 10)

const LOGIN_MAX_PER_MIN = Number.parseInt(process.env.LOGIN_MAX_PER_MIN || '12', 10)
const loginAttempts = new Map() // ip -> number[]

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length'
])

function now () {
  return Date.now()
}

function timingSafeEqual (a, b) {
  const aBuf = Buffer.from(String(a))
  const bBuf = Buffer.from(String(b))
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

function parseCookies (cookieHeader) {
  const out = {}
  if (!cookieHeader) return out
  const parts = cookieHeader.split(';')
  for (const p of parts) {
    const idx = p.indexOf('=')
    if (idx === -1) continue
    const k = p.slice(0, idx).trim()
    const v = p.slice(idx + 1).trim()
    out[k] = decodeURIComponent(v)
  }
  return out
}

function json (res, statusCode, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length)
  })
  res.end(body)
}

function openAiError (res, statusCode, message, code) {
  return json(res, statusCode, { error: { message, code } })
}

function text (res, statusCode, body, headers = {}) {
  const buf = Buffer.from(body)
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(buf.length),
    ...headers
  })
  res.end(buf)
}

function html (res, statusCode, body, headers = {}) {
  const buf = Buffer.from(body)
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(buf.length),
    ...headers
  })
  res.end(buf)
}

function redirect (res, location) {
  res.writeHead(302, { location })
  res.end()
}

function clientIp (req) {
  // If you later put this behind a proxy, add trusted proxy handling.
  return req.socket?.remoteAddress || 'unknown'
}

function isAuthed (req) {
  if (!APP_PASSKEY) return true
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies[COOKIE_NAME]
  if (!token) return false
  const record = sessions.get(token)
  if (!record) return false
  if (record.exp < now()) {
    sessions.delete(token)
    return false
  }
  return true
}

function requireAuth (req, res, { redirectToLogin }) {
  if (isAuthed(req)) return true
  if (redirectToLogin) {
    redirect(res, '/login')
    return false
  }
  json(res, 401, { error: 'unauthorized' })
  return false
}

async function readJsonBody (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}

function loginAllowed (ip) {
  const windowMs = 60_000
  const t = now()
  const arr = loginAttempts.get(ip) || []
  const fresh = arr.filter(ts => (t - ts) <= windowMs)
  if (fresh.length >= LOGIN_MAX_PER_MIN) {
    loginAttempts.set(ip, fresh)
    return false
  }
  fresh.push(t)
  loginAttempts.set(ip, fresh)
  return true
}

function setSessionCookie (res, token) {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(token).digest('base64url')
  const value = `${token}.${sig}`
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`
  res.setHeader('set-cookie', cookie)
}

function getSessionToken (req) {
  const cookies = parseCookies(req.headers.cookie)
  const value = cookies[COOKIE_NAME]
  if (!value) return null
  const idx = value.lastIndexOf('.')
  if (idx === -1) return null
  const token = value.slice(0, idx)
  const sig = value.slice(idx + 1)
  const expect = crypto.createHmac('sha256', COOKIE_SECRET).update(token).digest('base64url')
  if (!timingSafeEqual(sig, expect)) return null
  return token
}

function isAuthedSigned (req) {
  if (!APP_PASSKEY) return true
  const token = getSessionToken(req)
  if (!token) return false
  const record = sessions.get(token)
  if (!record) return false
  if (record.exp < now()) {
    sessions.delete(token)
    return false
  }
  return true
}

function requireAuthSigned (req, res, { redirectToLogin }) {
  if (isAuthedSigned(req)) return true
  if (redirectToLogin) return redirect(res, '/login')
  return json(res, 401, { error: 'unauthorized' })
}

function loginHtmlPage () {
  return `
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
      code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
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
  `.trim()
}

async function tryServeStatic (req, res, urlPath) {
  const safePath = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '')
  const filePath = resolve(join(STATIC_DIR, safePath))
  if (!filePath.startsWith(STATIC_DIR)) return false

  try {
    const st = await stat(filePath)
    if (!st.isFile()) return false
  } catch {
    return false
  }

  const ext = filePath.split('.').pop()?.toLowerCase()
  const type = ({
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    ico: 'image/x-icon',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8'
  })[ext] || 'application/octet-stream'

  res.writeHead(200, { 'content-type': type })
  createReadStream(filePath).pipe(res)
  return true
}

async function serveIndex (res) {
  const indexPath = join(STATIC_DIR, 'index.html')
  const body = await readFile(indexPath, 'utf8')
  html(res, 200, body)
}

function filterHeadersForUpstream (headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    if (v == null) continue
    out[k] = v
  }
  return out
}

async function proxyToUpstream (req, res) {
  if (!OPENAI_API_KEY) return openAiError(res, 500, 'OPENAI_API_KEY is not set on the gateway', 'missing_openai_api_key')

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  // Preserve path prefixes in UPSTREAM_BASE (e.g. https://right.codes/codex)
  const upstreamBaseUrl = new URL(UPSTREAM_BASE.endsWith('/') ? UPSTREAM_BASE : `${UPSTREAM_BASE}/`)
  const upstreamPath = (url.pathname + url.search).replace(/^\//, '')
  const upstream = new URL(upstreamPath, upstreamBaseUrl)

  const headers = filterHeadersForUpstream(req.headers)
  // Override any client-supplied Authorization so upstream always uses the server key.
  headers.authorization = `Bearer ${OPENAI_API_KEY}`

  const init = {
    method: req.method,
    headers
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    init.body = Buffer.concat(chunks)
  }

  let upstreamResp
  try {
    upstreamResp = await fetch(upstream, init)
  } catch (err) {
    const msg = String(err?.cause?.code || err?.message || err)
    return openAiError(res, 502, `upstream fetch failed: ${msg}`, 'upstream_fetch_failed')
  }

  // Normalize non-OpenAI-compatible error shapes like: {"error":"..."}
  if (upstreamResp.status >= 400) {
    const contentType = upstreamResp.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      try {
        const textBody = await upstreamResp.text()
        const parsed = JSON.parse(textBody)
        if (typeof parsed?.error === 'string') return openAiError(res, upstreamResp.status, parsed.error, 'upstream_error')
        if (typeof parsed?.message === 'string') return openAiError(res, upstreamResp.status, parsed.message, 'upstream_error')
        if (typeof parsed?.detail === 'string') return openAiError(res, upstreamResp.status, parsed.detail, 'upstream_error')
        if (Array.isArray(parsed?.detail)) {
          const msg = parsed.detail.map(d => d?.msg).filter(Boolean).join('; ')
          if (msg) return openAiError(res, upstreamResp.status, msg, 'upstream_error')
        }
        // If it's already OpenAI-shaped, fall through and pass-through.
        // Recreate a body stream since we've consumed it
        upstreamResp = new Response(textBody, { status: upstreamResp.status, headers: upstreamResp.headers })
      } catch {
        // ignore and pass-through
      }
    } else {
      // Some upstreams return text/html or text/plain on errors.
      try {
        const textBody = await upstreamResp.text()
        const excerpt = textBody.slice(0, 300).replace(/\s+/g, ' ').trim()
        if (excerpt) return openAiError(res, upstreamResp.status, excerpt, 'upstream_error')
        upstreamResp = new Response(textBody, { status: upstreamResp.status, headers: upstreamResp.headers })
      } catch {
        // ignore and pass-through
      }
    }
  }

  const respHeaders = {}
  upstreamResp.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return
    respHeaders[key] = value
  })

  res.writeHead(upstreamResp.status, respHeaders)
  if (!upstreamResp.body) return res.end()
  Readable.fromWeb(upstreamResp.body).pipe(res)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname

    if (path === '/health') return json(res, 200, { ok: true })

    if (path === '/login' && req.method === 'GET') {
      if (!APP_PASSKEY) return text(res, 500, 'APP_PASSKEY is not set')
      if (isAuthedSigned(req)) return redirect(res, '/')
      return html(res, 200, loginHtmlPage())
    }

    if (path === '/auth/login' && req.method === 'POST') {
      if (!APP_PASSKEY) return json(res, 500, { error: 'APP_PASSKEY is not set' })
      const ip = clientIp(req)
      if (!loginAllowed(ip)) return json(res, 429, { error: 'too many attempts, try again later' })
      const data = await readJsonBody(req).catch(() => ({}))
      const passkey = (data?.passkey || '').trim()
      if (!timingSafeEqual(passkey, APP_PASSKEY)) return json(res, 401, { error: 'invalid passkey' })
      const token = crypto.randomBytes(32).toString('base64url')
      sessions.set(token, { exp: now() + SESSION_TTL_MS })
      setSessionCookie(res, token)
      return json(res, 200, { ok: true })
    }

    if (path === '/auth/logout' && req.method === 'POST') {
      const token = getSessionToken(req)
      if (token) sessions.delete(token)
      res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`)
      return json(res, 200, { ok: true })
    }

    // API proxy
    if (path.startsWith('/v1/')) {
      if (!requireAuthSigned(req, res, { redirectToLogin: false })) return
      if (MODE !== 'proxy') return openAiError(res, 404, 'proxy disabled (MODE != proxy)', 'proxy_disabled')
      return await proxyToUpstream(req, res)
    }

    // UI routes (require auth if enabled)
    if (!requireAuthSigned(req, res, { redirectToLogin: true })) return

    if (path === '/' || path === '') {
      return await serveIndex(res)
    }

    const served = await tryServeStatic(req, res, path.slice(1))
    if (served) return

    // SPA fallback
    return await serveIndex(res)
  } catch (err) {
    console.error(err)
    return json(res, 500, { error: 'internal error' })
  }
})

server.on('error', (err) => {
  console.error(`Gateway failed to start: ${err?.message || err}`)
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`API2Web gateway listening on http://${HOST}:${PORT}`)
  // eslint-disable-next-line no-console
  console.log(`STATIC_DIR=${STATIC_DIR}`)
  // eslint-disable-next-line no-console
  console.log(`MODE=${MODE}`)
})
