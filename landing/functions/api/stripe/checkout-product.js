// POST /api/stripe/checkout-product
// Body: { slug: 'build-your-own-mcp' | 'mcp-server-pack' }
// Returns: { url } — redirect the user to Stripe Checkout.
//
// One-time-payment counterpart to /api/stripe/checkout (which handles
// the meridian Pro/Team subscription tiers). Same file delivery model
// as Gumroad: success_url → /api/stripe/claim-product?session_id=…
// renders an HTML page with the download link.

import { stripePost } from './_stripe.js'
import { jsonResponse, corsHeaders } from '../_orbital.js'
import { getProduct } from './_products.js'

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const slug = (body.slug || '').toString()
  const product = getProduct(slug)
  if (!product) return jsonResponse({ error: `unknown product: ${slug}` }, { status: 400 })

  const priceId = env[product.price_env_var]
  if (!priceId) return jsonResponse({ error: `${product.price_env_var} not configured` }, { status: 503 })
  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'STRIPE_SECRET_KEY not bound' }, { status: 503 })

  const origin = new URL(request.url).origin

  try {
    const session = await stripePost(env, '/checkout/sessions', {
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/api/stripe/claim-product?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/cancel.html`,
      automatic_tax: { enabled: false },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      // Email receipt automatically; we'll also expose download via /claim
      // in case the success-redirect page is closed before the user
      // copies the link.
      payment_intent_data: {
        receipt_email: undefined,  // taken from customer_details
        description: product.name,
        metadata: { slug },
      },
      metadata: {
        slug,
        product_name: product.name,
      },
      // Add a custom message on the Stripe-hosted success page that hints
      // at the next step. This shows BEFORE the redirect, in case the
      // user manually navigates away.
      custom_text: {
        submit: { message: `After payment, you'll be redirected to your download page.` },
      },
    })
    return jsonResponse({ url: session.url, id: session.id })
  } catch (e) {
    return jsonResponse({ error: e.message }, { status: 502 })
  }
}
