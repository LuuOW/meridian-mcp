// GET /api/version
// Server-driven UI: returns the current published meridian-skills-mcp version
// from the npm registry. Cached at the edge (Cache-Control: 1 h) and we
// also stash a copy in KV with TTL as a fallback when the npm registry is
// briefly unreachable. Frontend swaps the version badge after load.

import { jsonResponse, corsHeaders } from './_orbital.js'

const NPM_URL = 'https://registry.npmjs.org/meridian-skills-mcp'
const KV_KEY  = 'cache:npm-version'
const TTL     = 3600           // 1 hour

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return jsonResponse({ error: 'GET only' }, { status: 405 })

  // Try cache first
  if (env.MERIDIAN_KEYS) {
    const cached = await env.MERIDIAN_KEYS.get(KV_KEY, 'json')
    if (cached) return jsonResponse(cached, { headers: { 'cache-control': `public, max-age=${TTL}`, 'x-cache': 'kv-hit' } })
  }

  try {
    const res  = await fetch(NPM_URL, { cf: { cacheTtl: TTL, cacheEverything: true } })
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`)
    const data = await res.json()
    const npm  = data['dist-tags']?.latest
    if (!npm)  throw new Error('no latest version')

    const out = {
      npm,
      published_at: data.time?.[npm] || null,
      tarball:      data.versions?.[npm]?.dist?.tarball || null,
      fetched_at:   new Date().toISOString(),
    }
    if (env.MERIDIAN_KEYS) {
      await env.MERIDIAN_KEYS.put(KV_KEY, JSON.stringify(out), { expirationTtl: TTL })
    }
    return jsonResponse(out, { headers: { 'cache-control': `public, max-age=${TTL}`, 'x-cache': 'miss' } })
  } catch (e) {
    // Last resort — return a hardcoded fallback if both registry and KV fail.
    return jsonResponse({ npm: '1.0.0', error: e.message, fallback: true }, { status: 200 })
  }
}
