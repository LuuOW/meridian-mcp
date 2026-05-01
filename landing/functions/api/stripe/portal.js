// POST /api/stripe/portal  { api_key }
// Returns a Stripe Billing Portal URL where the customer can update their
// card / cancel / view invoices.

import { stripePost } from './_stripe.js'
import { sha256Hex, getKeyByHash } from './_keys.js'
import { jsonResponse, corsHeaders } from '../_orbital.js'

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON' }, { status: 400 }) }

  const rawKey = (body.api_key || '').toString()
  if (!rawKey.startsWith('mrd_live_')) return jsonResponse({ error: 'api_key required' }, { status: 400 })

  const hash = await sha256Hex(rawKey)
  const rec  = await getKeyByHash(env, hash)
  if (!rec) return jsonResponse({ error: 'unknown key' }, { status: 401 })

  const origin = new URL(request.url).origin
  try {
    const session = await stripePost(env, '/billing_portal/sessions', {
      customer:   rec.customer_id,
      return_url: `${origin}/`,
    })
    return jsonResponse({ url: session.url })
  } catch (e) {
    return jsonResponse({ error: e.message }, { status: 502 })
  }
}
