// POST /api/stripe/claim  { session_id }
// Called by /success.html after a successful Checkout. Returns the raw API
// key once. The KV entry that holds the raw value has a 10-minute TTL and
// is deleted on first read.

import { jsonResponse, corsHeaders } from '../_orbital.js'

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON' }, { status: 400 }) }

  const sid = (body.session_id || '').toString()
  if (!sid.startsWith('cs_')) return jsonResponse({ error: 'session_id required (cs_…)' }, { status: 400 })

  const stash = await env.MERIDIAN_KEYS.get(`session:${sid}`, 'json')
  if (!stash) {
    // Webhook may not have arrived yet — caller should retry.
    return jsonResponse({ error: 'key not ready (webhook still processing)', retry: true }, { status: 202 })
  }
  // One-shot read — delete so the key can never be retrieved again.
  await env.MERIDIAN_KEYS.delete(`session:${sid}`)
  return jsonResponse({
    api_key:        stash.raw,
    plan:           stash.plan,
    monthly_limit:  stash.monthly_limit,
  })
}
