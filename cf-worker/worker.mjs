// Meridian MCP — Cloudflare Worker (orbital task router) (remote / Streamable HTTP).
//
// Implements OAuth 2.1 + PKCE so connector hosts that require an
// authorization-code flow (Grok, ChatGPT custom MCP, Claude.ai
// connectors) can authenticate.
//
// Auth model: operator-pays. The Worker holds a single GitHub PAT in
// the MERIDIAN_GITHUB_TOKEN secret and uses it for every inference
// call. End users see a one-click *Authorize Meridian* page — no PAT
// pasting, no GitHub jargon. The OAuth flow exists purely to satisfy
// connector hosts that require it; the issued access tokens are
// random opaque identifiers (32 bytes) and carry no upstream
// credential.
//
// Endpoints
//   GET  /                              — version banner
//   GET  /healthz                       — liveness
//   GET  /.well-known/oauth-authorization-server
//                                       — RFC 8414 metadata so clients auto-discover
//   GET  /.well-known/oauth-protected-resource
//                                       — RFC 9728 metadata pointing /mcp at the AS
//   GET  /authorize?…                   — HTML form (paste GitHub PAT)
//   POST /authorize                     — form post, issues auth code, 302 to redirect_uri
//   POST /token                         — auth-code → access_token (PKCE verified)
//   POST /mcp                           — JSON-RPC over Streamable HTTP (bearer auth)
//

import { Server }                                 from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { PKG_VERSION, TOOLS, routeTask, routeTaskJson } from '../mcp/_lib/core.mjs'
import {
  applyFittedCorrection, sgdUpdate, loadWeights, saveWeights, FEATURE_VERSION,
} from './online_learning.mjs'

// Origins allowed to call the unauthenticated browser endpoint
// (POST /v1/route). The MCP `/mcp` endpoint still requires OAuth and
// is unaffected. This list is exact-match (host + scheme); add more
// here when bringing up a new Meridian sub-property.
const BROWSER_ORIGIN_ALLOWLIST = new Set([
  'https://lens.ask-meridian.uk',
  'https://ask-meridian.uk',
  'https://photon.ask-meridian.uk',
])

const ISSUER          = 'https://mcp.ask-meridian.uk'
const SUPPORTED_SCOPE = 'route_task'
const CODE_TTL_SEC    = 5 * 60          // 5 min — covers connector backends that don't redeem instantly
const TOKEN_TTL_SEC   = 7 * 24 * 60 * 60 // 7 days — avoid re-OAuth churn within a single Grok session/week
const KV_CODE_PREFIX  = 'code:'
const KV_TOKEN_PREFIX = 'tok:'

// Connector icon — the same orbital glyph used on ask-meridian.uk's
// favicon, served at /favicon.svg, /icon.svg, /logo.svg so any client
// that fingerprints the connector by domain (Grok, ChatGPT, Claude.ai,
// browsers) finds it. Also referenced from OAuth AS metadata via
// `logo_uri` and from MCP serverInfo via `_meta.iconUrl`.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%"   stop-color="#c4b5fd" stop-opacity="0.95"/>
      <stop offset="55%"  stop-color="#7c3aed" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#1e1b4b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="64" height="64" rx="12" fill="#0a0d14"/>
  <circle cx="32" cy="32" r="22" fill="none" stroke="#a78bfa" stroke-width="2.5" opacity="0.85"/>
  <circle cx="32" cy="32" r="14" fill="none" stroke="#38bdf8" stroke-width="1" opacity="0.5" stroke-dasharray="2 2"/>
  <circle cx="32" cy="32" r="9"  fill="url(#halo)"/>
  <circle cx="32" cy="32" r="3"  fill="#fef3c7"/>
  <circle cx="54" cy="22" r="2.2" fill="#7dd3fc" opacity="0.85"/>
  <circle cx="14" cy="44" r="1.6" fill="#6ee7b7" opacity="0.85"/>
</svg>`
const ICON_URL = `${ISSUER}/icon.svg`

const CORS = {
  'access-control-allow-origin':   '*',
  'access-control-allow-methods':  'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers':  'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, www-authenticate',
  'access-control-max-age':        '86400',
}

// ─── small helpers ─────────────────────────────────────────────────
function b64urlFromBytes(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return b64urlFromBytes(buf)
}

async function sha256B64url(text) {
  const buf = new TextEncoder().encode(text)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  return b64urlFromBytes(hash)
}

function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...(init.headers || {}) },
  })
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status || 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
  })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}

// ─── OAuth: discovery metadata ─────────────────────────────────────
function discoveryAS() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint:         `${ISSUER}/token`,
    response_types_supported: ['code'],
    grant_types_supported:    ['authorization_code'],
    code_challenge_methods_supported:        ['S256'],
    token_endpoint_auth_methods_supported:   ['none'],
    scopes_supported:        [SUPPORTED_SCOPE],
    // Hints that connector hosts use to render the brand:
    service_documentation:   'https://ask-meridian.uk/docs/',
    op_policy_uri:           'https://ask-meridian.uk/',
    op_tos_uri:              'https://ask-meridian.uk/',
    logo_uri:                ICON_URL,
  }
}

function discoveryProtectedResource() {
  return {
    resource: `${ISSUER}/mcp`,
    authorization_servers: [ISSUER],
    scopes_supported: [SUPPORTED_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation:  'https://ask-meridian.uk/docs/',
    resource_name:           'Meridian MCP',
    resource_logo_uri:       ICON_URL,
  }
}

// ─── /authorize ────────────────────────────────────────────────────
const AUTH_PARAMS = ['response_type','client_id','redirect_uri','scope','state','code_challenge','code_challenge_method']

function renderAuthorizePage(params) {
  const hidden = AUTH_PARAMS.map(k =>
    `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) || '')}">`).join('')
  const client = escapeHtml(params.get('client_id') || 'your AI host')
  return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Meridian MCP</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
  :root { color-scheme: dark }
  body { background:#0b0d12; color:#e6eaf2; font:14px/1.5 ui-sans-serif, system-ui, sans-serif; margin:0; padding:0; min-height:100vh; display:grid; place-items:center }
  .card { width:min(440px, calc(100vw - 32px)); background:#10131a; border:1px solid #1b2030; border-radius:14px; padding:28px 28px 24px; box-shadow:0 24px 60px rgba(0,0,0,.4) }
  .logo { font-size:24px; margin-bottom:14px }
  h1 { font-size:18px; font-weight:600; margin:0 0 6px }
  p  { color:#94a0b8; margin:0 0 14px }
  ul { color:#94a0b8; padding-left:18px; margin:0 0 18px }
  ul li { margin:4px 0 }
  button { margin-top:6px; width:100%; background:#5b8cff; color:#0b0d12; border:0; border-radius:8px; padding:12px; font-weight:600; font-size:14px; cursor:pointer }
  button:hover { background:#7aa3ff }
  .meta { margin-top:16px; color:#6c7790; font-size:11.5px; line-height:1.55 }
  a { color:#7aa3ff; text-decoration:none } a:hover { text-decoration:underline }
  code { background:#0b0d12; padding:1px 5px; border-radius:4px; border:1px solid #1b2030; font-size:12px }
  strong.client { color:#e6eaf2 }
</style>
</head><body>
  <form class="card" method="POST" action="/authorize">
    ${hidden}
    <div class="logo">🪐</div>
    <h1>Authorize <strong class="client">${client}</strong> to use Meridian</h1>
    <p>Meridian routes your task to the most relevant candidates. Click below and ${client} will be able to call:</p>
    <ul>
      <li><code>route_task</code> &mdash; ranks candidates for a query</li>
    </ul>
    <button type="submit">Authorize</button>
    <div class="meta">
      Hosted at <a href="https://ask-meridian.uk" target="_blank">ask-meridian.uk</a>. Inference runs on <a href="https://github.com/marketplace/models" target="_blank">GitHub Models</a>. The connection lasts 1&nbsp;hour and can be revoked at any time by reauthorizing.
    </div>
  </form>
</body></html>`
}

async function handleAuthorizeGet(url) {
  // Validate the bare minimum so the form post can succeed.
  const params = url.searchParams
  const required = ['response_type','client_id','redirect_uri','code_challenge','code_challenge_method']
  for (const k of required) {
    if (!params.get(k)) return textResponse(`missing ${k}`, { status: 400 })
  }
  if (params.get('response_type') !== 'code')           return textResponse('only response_type=code is supported', { status: 400 })
  if (params.get('code_challenge_method') !== 'S256')   return textResponse('only code_challenge_method=S256 is supported', { status: 400 })
  return htmlResponse(renderAuthorizePage(params))
}

async function handleAuthorizePost(req, env) {
  let form
  try { form = await req.formData() }
  catch { return textResponse('expected form-encoded body', { status: 400 }) }

  const get = (k) => form.get(k) ? String(form.get(k)) : ''
  const redirect_uri   = get('redirect_uri')
  const code_challenge = get('code_challenge')
  const code_method    = get('code_challenge_method')
  const scope          = get('scope') || SUPPORTED_SCOPE
  const state          = get('state')

  if (!redirect_uri || !code_challenge || code_method !== 'S256') {
    return textResponse('invalid OAuth params', { status: 400 })
  }

  const code = randomToken(32)
  await env.MCP_OAUTH.put(KV_CODE_PREFIX + code,
    JSON.stringify({ code_challenge, redirect_uri, scope }),
    { expirationTtl: CODE_TTL_SEC })

  // 302 back to the connector's redirect_uri.
  const dest = new URL(redirect_uri)
  dest.searchParams.set('code', code)
  if (state) dest.searchParams.set('state', state)
  return new Response(null, { status: 302, headers: { 'location': dest.toString(), ...CORS } })
}

// ─── /token ────────────────────────────────────────────────────────
async function handleTokenPost(req, env) {
  let form
  try { form = await req.formData() }
  catch {
    // Some clients send JSON to /token. Be permissive.
    try {
      const body = await req.clone().json()
      form = new Map(Object.entries(body))
      form.get = (k) => form instanceof Map ? form.get(k) : null
    } catch { return jsonResponse({ error: 'invalid_request', error_description: 'expected form or JSON body' }, { status: 400 }) }
  }
  const get = (k) => form.get(k) ? String(form.get(k)) : ''

  if (get('grant_type') !== 'authorization_code') {
    return jsonResponse({ error: 'unsupported_grant_type' }, { status: 400 })
  }
  const code           = get('code')
  const code_verifier  = get('code_verifier')
  const redirect_uri   = get('redirect_uri')
  if (!code || !code_verifier) {
    return jsonResponse({ error: 'invalid_request', error_description: 'code and code_verifier required' }, { status: 400 })
  }

  // CF KV is eventually consistent across edges. The /authorize POST may have
  // landed at one edge (LATAM if user clicked from Argentina) while /token lands
  // at a US edge (where Grok's backend lives). Retry briefly so propagation
  // catches up — without this, Grok sees invalid_grant and re-prompts.
  let stored = null
  for (const wait of [0, 250, 500, 1000, 2000]) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    stored = await env.MCP_OAUTH.get(KV_CODE_PREFIX + code, 'json')
    if (stored) break
  }
  if (!stored) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'auth code unknown or expired' }, { status: 400 })
  }
  // Single-use: delete immediately.
  await env.MCP_OAUTH.delete(KV_CODE_PREFIX + code)

  const expected = await sha256B64url(code_verifier)
  if (expected !== stored.code_challenge) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, { status: 400 })
  }
  if (redirect_uri && redirect_uri !== stored.redirect_uri) {
    return jsonResponse({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, { status: 400 })
  }

  // Issue an opaque access token. The token is just a validity
  // marker — the upstream PAT lives in the Worker secret, not in KV.
  const access_token = randomToken(32)
  await env.MCP_OAUTH.put(KV_TOKEN_PREFIX + access_token,
    JSON.stringify({ scope: stored.scope, issued_at: Date.now() }),
    { expirationTtl: TOKEN_TTL_SEC })

  return jsonResponse({
    access_token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_SEC,
    scope: stored.scope || SUPPORTED_SCOPE,
  })
}

// ─── bearer → PAT resolver (used by /mcp) ─────────────────────────
// All inference uses the operator's MERIDIAN_GITHUB_TOKEN secret. The
// bearer token is only a marker that says "this caller completed the
// OAuth dance" — it's not a credential carrier.
async function resolveBearer(bearer, env) {
  if (!bearer) return { error: 'missing Authorization: Bearer <access-token>' }
  // Same edge-propagation issue as in /token: a token issued at edge A may
  // hit /mcp at edge B before KV catches up. Retry briefly.
  let stored = null
  for (const wait of [0, 250, 500, 1000]) {
    if (wait) await new Promise(r => setTimeout(r, wait))
    stored = await env.MCP_OAUTH.get(KV_TOKEN_PREFIX + bearer, 'json')
    if (stored) break
  }
  if (!stored) return { error: 'invalid or expired access token' }
  if (!env.MERIDIAN_GITHUB_TOKEN) return { error: 'server misconfigured: MERIDIAN_GITHUB_TOKEN secret unset' }
  return { token: env.MERIDIAN_GITHUB_TOKEN }
}

function bearerOf(req) {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

// ─── /mcp handler ──────────────────────────────────────────────────
function buildMcpServer(githubToken, env) {
  const server = new Server(
    {
      name: 'meridian',
      version: PKG_VERSION,
      // _meta is the MCP convention for arbitrary metadata; clients
      // that surface a connector icon (e.g. Grok, Claude.ai) often
      // pull it from here. Harmless on clients that don't read it.
      _meta: {
        iconUrl:    ICON_URL,
        websiteUrl: 'https://ask-meridian.uk',
      },
    },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name !== 'route_task') {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
    try {
      const text = await routeTask({
        task: args.task, limit: args.limit, token: githubToken,
        opts: {
          endpoint:   env.MERIDIAN_MODELS_ENDPOINT,
          model:      env.MERIDIAN_MODEL,
          timeoutMs:  env.MERIDIAN_TIMEOUT_MS  ? parseInt(env.MERIDIAN_TIMEOUT_MS, 10)  : undefined,
          candidates: env.MERIDIAN_CANDIDATES  ? parseInt(env.MERIDIAN_CANDIDATES, 10)  : undefined,
        },
      })
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true }
    }
  })

  return server
}

// Browser-facing route. Same operator-pays model as the OAuth-gated
// /mcp endpoint, but skips the OAuth dance for first-party Meridian
// front-ends (lens, the marketing site, etc.) — Origin is
// allowlisted, the request is rejected otherwise. Returns the
// structured classifier output so callers can render orbits.
async function handleBrowserRoute(request, env) {
  const origin = request.headers.get('origin') || ''
  if (!BROWSER_ORIGIN_ALLOWLIST.has(origin)) {
    return jsonResponse({ error: 'origin not allowed', origin }, { status: 403 })
  }
  if (!env.MERIDIAN_GITHUB_TOKEN) {
    return jsonResponse({ error: 'server misconfigured: MERIDIAN_GITHUB_TOKEN secret unset' }, { status: 500 })
  }

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'expected JSON body' }, { status: 400 }) }

  try {
    const result = await routeTaskJson({
      task:  body.task,
      limit: body.limit,
      token: env.MERIDIAN_GITHUB_TOKEN,
      opts: {
        endpoint:   env.MERIDIAN_MODELS_ENDPOINT,
        model:      env.MERIDIAN_MODEL,
        timeoutMs:  env.MERIDIAN_TIMEOUT_MS  ? parseInt(env.MERIDIAN_TIMEOUT_MS, 10)  : undefined,
        candidates: env.MERIDIAN_CANDIDATES  ? parseInt(env.MERIDIAN_CANDIDATES, 10)  : undefined,
      },
    })
    // Apply fitted correction if a model has been trained. Heuristic
    // route_score is the cold-start base; fitted weights nudge the
    // ranking toward what users actually pick. Day 1: pure heuristic.
    // Month 3: dominantly fitted. See cf-worker/online_learning.mjs.
    const weights = await loadWeights(env.MCP_OAUTH)
    if (weights) {
      result.selected = applyFittedCorrection(result.selected || [], weights)
      result._fitted_meta = {
        version:   weights.version,
        n_updates: weights.n_updates ?? 0,
      }
    } else {
      result._fitted_meta = { version: FEATURE_VERSION, n_updates: 0, cold_start: true }
    }
    return jsonResponse(result)
  } catch (e) {
    return jsonResponse({ error: e.message || String(e) }, { status: 502 })
  }
}

// Browser-facing feedback endpoint. Front-ends post the candidates
// they showed the user and which one the user engaged with. The
// Worker pulls fitted weights from KV, runs one pairwise-ranking
// SGD step, writes them back. Constant-time per request.
//
// Body shape:
//   {
//     query:       "rate-limit a public API",
//     selected:    [ /* same shape as /v1/route's `selected` array */ ],
//     chosen_slug: "redis-token-bucket",
//     action:      "click" | "detail_open" | "copy" | "thumbs_up" | "dismiss"
//   }
//
// `dismiss` skips updating; only positive engagements train. This
// avoids penalising candidates the user simply didn't have time to
// look at.
async function handleBrowserFeedback(request, env) {
  const origin = request.headers.get('origin') || ''
  if (!BROWSER_ORIGIN_ALLOWLIST.has(origin)) {
    return jsonResponse({ error: 'origin not allowed', origin }, { status: 403 })
  }

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'expected JSON body' }, { status: 400 }) }

  const action = body.action || 'click'
  const candidates = Array.isArray(body.selected) ? body.selected : []
  if (action === 'dismiss' || !body.chosen_slug || candidates.length < 2) {
    // No training signal — record-only. We still return ok=true so
    // clients can fire-and-forget.
    return jsonResponse({ ok: true, applied: false, reason: 'no positive signal' })
  }

  const chosenIdx = candidates.findIndex(s => s.slug === body.chosen_slug)
  if (chosenIdx < 0) {
    return jsonResponse({ error: 'chosen_slug not in selected[]' }, { status: 400 })
  }

  try {
    const current = await loadWeights(env.MCP_OAUTH)
    const next    = sgdUpdate(current, candidates, chosenIdx)
    await saveWeights(env.MCP_OAUTH, next)
    return jsonResponse({
      ok:           true,
      applied:      true,
      n_updates:    next.n_updates,
      n_pairs:      next.n_pairs,
      version:      next.version,
    })
  } catch (e) {
    return jsonResponse({ error: e.message || String(e) }, { status: 500 })
  }
}

async function handleMcp(request, env) {
  const bearer   = bearerOf(request)
  const resolved = await resolveBearer(bearer, env)
  if (resolved.error) {
    // RFC 9728 / 6750: 401 with WWW-Authenticate so clients know which AS to use.
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: resolved.error } }),
      { status: 401, headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer realm="meridian-mcp", resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
          ...CORS,
      } },
    )
  }

  const server    = buildMcpServer(resolved.token, env)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  try {
    await server.connect(transport)
    const res = await transport.handleRequest(request)
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
    return new Response(res.body, { status: res.status, headers })
  } catch (e) {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `internal error: ${e.message || e}` } }, { status: 500 })
  }
}

// ─── router ────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/healthz')
      return textResponse('ok')

    if (url.pathname === '/' && request.method === 'GET')
      return textResponse(`Meridian MCP v — POST /mcp with bearer token. https://ask-meridian.uk\n`)

    // Icon endpoints — served from the SVG embedded above. Multiple
    // paths because different connector hosts probe different ones.
    if (request.method === 'GET' && (
        url.pathname === '/favicon.svg' ||
        url.pathname === '/icon.svg'    ||
        url.pathname === '/logo.svg')) {
      return new Response(ICON_SVG, {
        status: 200,
        headers: {
          'content-type': 'image/svg+xml',
          'cache-control': 'public, max-age=86400',
          ...CORS,
        },
      })
    }
    // Some clients/browsers probe /favicon.ico — redirect to the SVG.
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      return Response.redirect(`${ISSUER}/favicon.svg`, 301)
    }

    if (url.pathname === '/.well-known/oauth-authorization-server')
      return jsonResponse(discoveryAS())
    if (url.pathname === '/.well-known/oauth-protected-resource')
      return jsonResponse(discoveryProtectedResource())

    if (url.pathname === '/authorize' && request.method === 'GET')
      return handleAuthorizeGet(url)
    if (url.pathname === '/authorize' && request.method === 'POST')
      return handleAuthorizePost(request, env)

    if (url.pathname === '/token' && request.method === 'POST')
      return handleTokenPost(request, env)

    if (url.pathname === '/mcp')
      return handleMcp(request, env)

    if (url.pathname === '/v1/route' && request.method === 'POST')
      return handleBrowserRoute(request, env)

    if (url.pathname === '/v1/feedback' && request.method === 'POST')
      return handleBrowserFeedback(request, env)

    // Read-only endpoint for the eval cron + dashboards. Returns the
    // current model's update count + version, no weights.
    if (url.pathname === '/v1/model-info' && request.method === 'GET') {
      const w = await loadWeights(env.MCP_OAUTH)
      return jsonResponse({
        version:    FEATURE_VERSION,
        n_updates:  w?.n_updates ?? 0,
        n_pairs:    w?.n_pairs   ?? 0,
        updated_at: w?.updated_at || null,
        cold_start: !w,
      })
    }

    return textResponse('not found', { status: 404 })
  },
}
