// stripe-helper.mjs — Stripe SDK wrapper
import Stripe from 'stripe'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRICES_FILE = join(__dirname, '..', 'data', 'prices.json')

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY
if (!STRIPE_SECRET) throw new Error('STRIPE_SECRET_KEY or STRIPE_RESTRICTED_KEY required')

export const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2025-02-24.acacia' })

// Plan → monthly quota
export const PLAN_QUOTAS = {
  pro:  10_000,
  team: 100_000,
}

export function loadPrices() {
  if (!existsSync(PRICES_FILE)) return {}
  try { return JSON.parse(readFileSync(PRICES_FILE, 'utf8')) }
  catch { return {} }
}

export function savePrices(data) {
  writeFileSync(PRICES_FILE, JSON.stringify(data, null, 2))
}

/**
 * Create a Checkout Session for a given plan.
 * Returns { url, session_id }
 */
export async function createCheckoutSession({ plan, successUrl, cancelUrl }) {
  if (!['pro', 'team'].includes(plan)) throw new Error(`invalid plan: ${plan}`)
  const prices = loadPrices()
  const priceId = prices[plan]
  if (!priceId) throw new Error(`no price ID set for plan ${plan} — run setup-stripe.mjs first`)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  cancelUrl,
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata: { meridian_plan: plan },
    subscription_data: { metadata: { meridian_plan: plan } },
  })
  return { url: session.url, session_id: session.id }
}

/**
 * Verify + parse a Stripe webhook payload.
 * Returns the parsed event, or throws on invalid signature.
 */
export function verifyWebhook({ rawBody, signature, webhookSecret }) {
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
}
