// POST /api/stripe/webhook
// Stripe POSTs events here. We verify the signature, then react to:
//   checkout.session.completed       → mint API key, store hash in KV
//   customer.subscription.deleted    → mark key inactive

import { verifyStripeSignature } from './_stripe.js'
import { mintKey, putKey, getHashByCustomer, getKeyByHash, planLimits, thisMonth } from './_keys.js'

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 })

  const sig = request.headers.get('stripe-signature')
  if (!sig)                     return new Response('missing stripe-signature', { status: 400 })
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('STRIPE_WEBHOOK_SECRET not bound', { status: 503 })

  const rawBody = await request.text()
  const ok = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)
  if (!ok) return new Response('invalid signature', { status: 400 })

  let evt
  try { evt = JSON.parse(rawBody) }
  catch { return new Response('invalid JSON', { status: 400 }) }

  switch (evt.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(env, evt.data.object)
      return new Response('ok', { status: 200 })

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(env, evt.data.object)
      return new Response('ok', { status: 200 })

    default:
      // Acknowledge other events so Stripe doesn't retry
      return new Response('ignored', { status: 200 })
  }
}

async function handleCheckoutCompleted(env, session) {
  const customer_id = session.customer
  const plan        = session.metadata?.plan || session.subscription_data?.metadata?.plan
  if (!customer_id || !plan) return

  // Idempotency — if we've already minted a key for this customer, leave it.
  const existing = await getHashByCustomer(env, customer_id)
  if (existing) {
    const rec = await getKeyByHash(env, existing)
    if (rec?.active) return
  }

  const limits = planLimits(plan)
  if (!limits) return

  const { raw, hash } = await mintKey()
  const record = {
    plan,
    customer_id,
    subscription_id:   session.subscription || null,
    monthly_limit:     limits.monthly_limit,
    calls_this_month:  0,
    month_start:       thisMonth(),
    created_at:        new Date().toISOString(),
    last_used_at:      null,
    active:            true,
  }
  await putKey(env, hash, record)

  // Stash raw key keyed by session id with short TTL so the success page
  // can claim it once. After 10 minutes it's gone — caller must save it.
  await env.MERIDIAN_KEYS.put(
    `session:${session.id}`,
    JSON.stringify({ raw, plan, monthly_limit: limits.monthly_limit }),
    { expirationTtl: 600 },
  )
}

async function handleSubscriptionDeleted(env, subscription) {
  const customer_id = subscription.customer
  const hash = await getHashByCustomer(env, customer_id)
  if (!hash) return
  const rec = await getKeyByHash(env, hash)
  if (!rec) return
  rec.active = false
  rec.deactivated_at = new Date().toISOString()
  await putKey(env, hash, rec)
}
