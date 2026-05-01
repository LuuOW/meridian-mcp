// POST /api/stripe/claim  { session_id }
// Returns the raw API key once. Two paths:
//   1. Webhook already fired → KV `session:<id>` has the raw key. Return it
//      and delete the entry (claim-once).
//   2. Webhook hasn't fired (delayed, or STRIPE_WEBHOOK_SECRET not yet bound)
//      → fetch the Checkout Session via Stripe API, verify status=complete +
//      payment_status=paid, then mint a key just-in-time. Idempotent: if a
//      key already exists for this customer, return that one.

import { stripeGet } from './_stripe.js'
import {
  mintKey, sha256Hex, putKey, getKeyByHash, getHashByCustomer,
  planLimits, thisMonth,
} from './_keys.js'
import { jsonResponse, corsHeaders } from '../_orbital.js'

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON' }, { status: 400 }) }

  const sid = (body.session_id || '').toString()
  if (!sid.startsWith('cs_')) return jsonResponse({ error: 'session_id required (cs_…)' }, { status: 400 })

  // Path 1 — webhook already wrote the raw key into KV.
  const stash = await env.MERIDIAN_KEYS.get(`session:${sid}`, 'json')
  if (stash) {
    await env.MERIDIAN_KEYS.delete(`session:${sid}`)
    return jsonResponse({
      api_key:        stash.raw,
      plan:           stash.plan,
      monthly_limit:  stash.monthly_limit,
      via:            'webhook',
    })
  }

  // Path 2 — fallback: verify with Stripe directly, mint just-in-time.
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: 'STRIPE_SECRET_KEY not bound', retry: false }, { status: 503 })
  }

  let session
  try { session = await stripeGet(env, `/checkout/sessions/${sid}`) }
  catch (e) { return jsonResponse({ error: 'cannot fetch session: ' + e.message }, { status: 502 }) }

  if (session.status !== 'complete')           return jsonResponse({ error: `session not complete (${session.status})`, retry: true }, { status: 202 })
  if (session.payment_status !== 'paid')       return jsonResponse({ error: `payment not confirmed (${session.payment_status})`, retry: true }, { status: 202 })

  const customer_id = session.customer
  const plan        = session.metadata?.plan || 'pro'
  const limits      = planLimits(plan)
  if (!customer_id || !limits) return jsonResponse({ error: 'session missing customer or plan' }, { status: 502 })

  // Idempotency — if a key already exists for this customer, we cannot show
  // its raw value (only the hash is stored). Return a clear message instead
  // of minting a duplicate.
  const existingHash = await getHashByCustomer(env, customer_id)
  if (existingHash) {
    const rec = await getKeyByHash(env, existingHash)
    if (rec?.active) {
      return jsonResponse({
        error: 'a key has already been minted for this subscription. Email hello@ask-meridian.uk to rotate.',
      }, { status: 409 })
    }
  }

  const { raw, hash } = await mintKey()
  await putKey(env, hash, {
    plan,
    customer_id,
    subscription_id:   session.subscription || null,
    monthly_limit:     limits.monthly_limit,
    calls_this_month:  0,
    month_start:       thisMonth(),
    created_at:        new Date().toISOString(),
    last_used_at:      null,
    active:            true,
  })

  return jsonResponse({
    api_key:        raw,
    plan,
    monthly_limit:  limits.monthly_limit,
    via:            'just-in-time',
  })
}
