// POST /api/stripe/checkout
// Body: { plan: "pro" | "team" }
// Returns: { url } — redirect the user there.

import { stripePost } from './_stripe.js'
import { jsonResponse, corsHeaders } from '../_orbital.js'

const PLAN_TO_PRICE_ENV = {
  pro:  'STRIPE_PRICE_PRO',
  team: 'STRIPE_PRICE_TEAM',
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const plan = (body.plan || '').toString()
  const priceEnvVar = PLAN_TO_PRICE_ENV[plan]
  if (!priceEnvVar) return jsonResponse({ error: `unknown plan: ${plan}` }, { status: 400 })

  const priceId = env[priceEnvVar]
  if (!priceId)  return jsonResponse({ error: `${priceEnvVar} not configured` }, { status: 503 })
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'STRIPE_SECRET_KEY not bound' }, { status: 503 })

  const origin = new URL(request.url).origin

  try {
    const session = await stripePost(env, '/checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/cancel.html`,
      automatic_tax: { enabled: false },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      subscription_data: {
        metadata: { plan },
      },
      metadata: { plan },
    })
    return jsonResponse({ url: session.url, id: session.id })
  } catch (e) {
    return jsonResponse({ error: e.message }, { status: 502 })
  }
}
