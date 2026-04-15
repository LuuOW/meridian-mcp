#!/usr/bin/env node
// setup-stripe.mjs — run once to create Products + Prices + save IDs
import { stripe, loadPrices, savePrices } from './stripe-helper.mjs'

const PLANS = [
  {
    plan: 'pro',
    name: 'Meridian Pro',
    description: 'Hosted Meridian MCP — 10,000 tool calls/month, HTTP transport, World-ID verified.',
    amount_usd: 29,
  },
  {
    plan: 'team',
    name: 'Meridian Team',
    description: 'Hosted Meridian MCP — 100,000 tool calls/month, 5 keys, priority support.',
    amount_usd: 149,
  },
]

async function main() {
  const existing = loadPrices()
  for (const { plan, name, description, amount_usd } of PLANS) {
    if (existing[plan]) {
      console.log(`✓ ${plan} already configured → price ${existing[plan]}`)
      continue
    }
    console.log(`Creating product "${name}"…`)
    const product = await stripe.products.create({
      name, description,
      metadata: { meridian_plan: plan },
    })
    const price = await stripe.prices.create({
      product:  product.id,
      unit_amount: amount_usd * 100,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: { meridian_plan: plan },
    })
    existing[plan] = price.id
    savePrices(existing)
    console.log(`✓ ${plan}: product=${product.id} price=${price.id}`)
  }
  console.log('Done. Prices saved to data/prices.json')
}

main().catch(e => { console.error(e); process.exit(1) })
