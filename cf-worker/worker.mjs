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

import { PKG_VERSION, TOOLS, routeTask, routeTaskJson, DEFAULTS } from '../mcp/_lib/core.mjs'
import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
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
  'https://meridian.ask-meridian.uk',  // shared-origin host: lens/helix/miniapp/vision-lab
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

// Browser-facing vision endpoint. Accepts a base64 image + a short
// prompt, returns the model's text description. Used by helix (injury
// photo) and miniapp/vision-lab (snap-and-ask). Wraps a vision-capable
// GH Models endpoint; default GPT-4o-mini, swap via MERIDIAN_VISION_MODEL.
async function handleVision(request, env) {
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

  const prompt   = String(body.prompt || 'Describe this image concisely.').slice(0, 800)
  const imageUrl = String(body.image_url || body.image || '')
  if (!imageUrl) return jsonResponse({ error: 'image_url required (https URL or data: URI)' }, { status: 400 })
  if (imageUrl.length > 8 * 1024 * 1024) return jsonResponse({ error: 'image too large (max ~6 MB as data:URI)' }, { status: 413 })

  const model    = env.MERIDIAN_VISION_MODEL || 'openai/gpt-4o-mini'
  const endpoint = env.MERIDIAN_MODELS_ENDPOINT || 'https://models.github.ai/inference/chat/completions'
  const ctrl     = new AbortController()
  const timer    = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MERIDIAN_GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': `meridian-mcp/${PKG_VERSION}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 240,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
      }),
      signal: ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return jsonResponse({ error: j.error?.message || j.message || `HTTP ${res.status}` }, { status: 502 })
    const text = j.choices?.[0]?.message?.content
    if (!text) return jsonResponse({ error: 'vision model returned empty content' }, { status: 502 })
    return jsonResponse({ description: text, model })
  } catch (e) {
    return jsonResponse({ error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) }, { status: 502 })
  } finally {
    clearTimeout(timer)
  }
}

// helix: rank therapeutic protein candidates for an injury description.
// Browser sends the curated candidate table inline so the worker has no
// hidden state. Uses the same text model as /v1/route (Llama-3.3-70B).
// /v1/helix-explain — given a protein + a selected residue/ligand
// (compId, seqId, asymId, atomName, element), generate 1-2 sentences
// of biological role for that specific selection. Used by the helix
// frontend to backfill the detail panel + fullscreen HUD after click.
async function handleHelixExplain(request, env) {
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

  const proteinName = String(body.protein_name || '').slice(0, 120)
  const uniprot     = String(body.uniprot || '').slice(0, 20)
  const pdb         = String(body.pdb || '').slice(0, 6)
  const sel         = body.selection || {}
  if (!proteinName || !sel.compId) {
    return jsonResponse({ error: 'protein_name and selection.compId required' }, { status: 400 })
  }

  const selDesc = [
    sel.kind === 'ligand' ? 'Ligand/cofactor' : 'Residue',
    sel.compId,
    sel.seqId  ? `at sequence position ${sel.seqId}` : '',
    sel.asymId ? `on chain ${sel.asymId}`            : '',
    sel.atomName ? `(atom ${sel.atomName})`          : '',
    sel.element  ? `[element ${sel.element}]`        : '',
  ].filter(Boolean).join(' ')

  const sys = `You are a structural-biology assistant. Given a therapeutic protein and one specific selected residue or ligand within its experimentally-determined PDB structure, explain in 1-2 concise sentences what role THAT SPECIFIC selection plays in the protein's biological function — focus on the position, not generic descriptions. If it is a known catalytic residue, binding-site contact, metal coordination, glycosylation site, disulfide partner, or structural feature, mention it specifically. If the position has no notable role, say "no specifically noted role at this position" — do not pad. Do not repeat what the protein does overall; the user already knows that.`

  const user = `Protein: ${proteinName}${uniprot ? ` (UniProt ${uniprot})` : ''}${pdb ? `, PDB ${pdb}` : ''}
Selection: ${selDesc}

What does this specific selection do in this protein?`

  const model    = env.MERIDIAN_MODEL || DEFAULTS.model
  const endpoint = env.MERIDIAN_MODELS_ENDPOINT || DEFAULTS.endpoint
  const ctrl     = new AbortController()
  const timer    = setTimeout(() => ctrl.abort(), 25_000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MERIDIAN_GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': `meridian-mcp/${PKG_VERSION}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: user },
        ],
      }),
      signal: ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return jsonResponse({ error: j.error?.message || `HTTP ${res.status}` }, { status: 502 })
    const description = (j.choices?.[0]?.message?.content || '').trim()
    return jsonResponse({ description, model })
  } catch (e) {
    return jsonResponse({ error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) }, { status: 502 })
  } finally {
    clearTimeout(timer)
  }
}

async function handleHelix(request, env) {
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

  const desc       = String(body.injury_description || '').slice(0, 4000).trim()
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 200) : []
  const limit      = Math.max(1, Math.min(10, parseInt(body.limit, 10) || 5))
  if (!desc)               return jsonResponse({ error: 'injury_description required' }, { status: 400 })
  if (!candidates.length)  return jsonResponse({ error: 'candidates table required' }, { status: 400 })

  const table = candidates.map(p =>
    `- ${p.name} (${p.uniprot}, ${p.aa_len ?? '?'} aa) — use: ${p.use}; notes: ${p.notes || ''}`
  ).join('\n')

  const system = `You are a research assistant helping triage therapeutic protein candidates for a clinical wet lab. You are NOT giving medical advice. Always disclose uncertainty. Output strict JSON only — no prose around it.`
  const user = `Injury description:
${desc}

Therapeutic protein table (curated):
${table}

Task: pick the top ${limit} candidates for further investigation. Score each 0-100 on plausibility for THIS injury, give a one-sentence mechanism rationale, and flag any candidate where size/delivery is a known barrier.

Output strict JSON:
{
  "injury_class": "<short class label>",
  "candidates": [
    {"uniprot": "...", "name": "...", "score": 0-100, "rationale": "...", "delivery_concern": null | "..."}
  ],
  "not_medical_advice": true
}`

  const model    = env.MERIDIAN_MODEL || 'meta/llama-3.3-70b-instruct'
  const endpoint = env.MERIDIAN_MODELS_ENDPOINT || 'https://models.github.ai/inference/chat/completions'
  const ctrl     = new AbortController()
  const timer    = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MERIDIAN_GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': `meridian-mcp/${PKG_VERSION}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
      }),
      signal: ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return jsonResponse({ error: j.error?.message || j.message || `HTTP ${res.status}` }, { status: 502 })
    const text = j.choices?.[0]?.message?.content
    if (!text) return jsonResponse({ error: 'LLM returned empty content' }, { status: 502 })
    let parsed
    try { parsed = JSON.parse(text) }
    catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return jsonResponse({ error: 'no JSON in response', raw: text.slice(0, 200) }, { status: 502 })
      parsed = JSON.parse(m[0])
    }
    // Closing the loop: run the same orbital classifier the /v1/route
    // pipeline uses, so helix's galaxy view positions each protein with
    // the project's canonical physics signature. Each LLM-ranked entry
    // is reshaped as a candidate (slug = UniProt id, keywords drawn
    // from the source row), then orbitalClassify ranks them. The LLM
    // score and orbital route_score are surfaced together — the LLM
    // owns medical plausibility, the classifier owns spatial layout.
    try {
      const byUniprot = new Map(candidates.map(c => [c.uniprot, c]))
      const protCandidates = (parsed.candidates || []).map(c => {
        const src = byUniprot.get(c.uniprot) || {}
        const kw = String(src.use || '')
          .toLowerCase()
          .split(/[,\s]+/)
          .filter(w => w.length > 2)
          .slice(0, 10)
        return {
          slug:        c.uniprot,
          name:        c.name || src.name || c.uniprot,
          description: c.rationale || src.use || '',
          keywords:    kw,
          body:        `## ${c.name || src.name}\n\n${c.rationale || ''}\n\n**Notes:** ${src.notes || ''}\n**Size:** ${src.aa_len || '?'} aa`,
          // Carry LLM-side payload through to the front-end.
          llm_score:        c.score ?? null,
          delivery_concern: c.delivery_concern || null,
          uniprot:          c.uniprot,
        }
      })
      const ranked = orbitalClassify(protCandidates, desc)
      // orbitalClassify only carries slug + classifier-derived fields;
      // re-attach the LLM-side payload by uniprot so the front-end can
      // surface both scores side-by-side on the detail panel.
      const llmByUniprot = new Map((parsed.candidates || []).map(c => [c.uniprot, c]))
      parsed.candidates = ranked.map(r => ({
        ...r,
        uniprot:          r.slug,
        llm_score:        llmByUniprot.get(r.slug)?.score ?? null,
        rationale:        llmByUniprot.get(r.slug)?.rationale ?? r.description,
        delivery_concern: llmByUniprot.get(r.slug)?.delivery_concern || null,
      }))
      parsed.candidates_generated = protCandidates.length
    } catch (e) {
      console.warn('orbital classify failed (non-fatal):', e?.message || e)
    }
    return jsonResponse(parsed)
  } catch (e) {
    return jsonResponse({ error: e.name === 'AbortError' ? 'timeout' : (e.message || String(e)) }, { status: 502 })
  } finally {
    clearTimeout(timer)
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

    if (url.pathname === '/v1/vision' && request.method === 'POST')
      return handleVision(request, env)

    if (url.pathname === '/v1/helix-explain' && request.method === 'POST')
      return handleHelixExplain(request, env)

    if (url.pathname === '/v1/helix' && request.method === 'POST')
      return handleHelix(request, env)

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
