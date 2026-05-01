// Pure-fetch Stripe client. We don't bundle the npm 'stripe' SDK — the
// Pages Function isolate would carry too much weight, and the four endpoints
// we need (sessions, customers retrieve, signature verify, billing portal)
// are trivial to call directly.

const STRIPE_API = 'https://api.stripe.com/v1'

export async function stripePost(env, path, formParams) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not bound')
  const body = new URLSearchParams()
  flattenParams(formParams, '', body)
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Stripe ${path}: ${data.error?.message || res.status}`)
  return data
}

export async function stripeGet(env, path) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not bound')
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Stripe ${path}: ${data.error?.message || res.status}`)
  return data
}

// Stripe wants nested objects flattened with bracket-notation:
//   { line_items: [{ price: 'p', qty: 1 }] }  →  line_items[0][price]=p&line_items[0][qty]=1
function flattenParams(obj, prefix, params) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') flattenParams(item, `${key}[${i}]`, params)
        else                          params.append(`${key}[${i}]`, String(item))
      })
    } else if (typeof v === 'object') {
      flattenParams(v, key, params)
    } else {
      params.append(key, String(v))
    }
  }
}

// Verify a Stripe webhook signature — no SDK needed, pure WebCrypto HMAC.
// Stripe-Signature looks like: "t=1234567890,v1=hex,v1=hex_secondary,..."
export async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => {
      const i = p.indexOf('=')
      return [p.slice(0, i), p.slice(i + 1)]
    })
  )
  const t = parts.t
  const v1 = sigHeader.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3))
  if (!t || !v1.length) return false
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > toleranceSec) return false

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)))
  const sigHex   = Array.from(sigBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  for (const candidate of v1) {
    if (timingSafeEqualHex(sigHex, candidate)) return true
  }
  return false
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}
