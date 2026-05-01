// Shared utilities for the API-key system.
//
// Storage:
//   KV namespace MERIDIAN_KEYS (bound as env.MERIDIAN_KEYS).
//   Forward index:  key:<sha256_hex>           → { plan, customer_id, ... }
//   Reverse index:  customer:<cus_id>          → <sha256_hex>
//                   session:<cs_id>            → { hash, raw }   (short TTL — claim-once)

const PLAN_LIMITS = {
  pro:  { monthly_limit: 10000,  display: 'Pro'  },
  team: { monthly_limit: 100000, display: 'Team' },
}

export function planLimits(plan) { return PLAN_LIMITS[plan] || null }

// Generate a fresh API key. The raw value is shown to the user once on the
// success page; only the hash is persisted server-side. The prefix makes
// stray copies grep-friendly in logs / GitHub Code Search.
export async function mintKey() {
  const random = crypto.getRandomValues(new Uint8Array(24))
  const b64 = btoa(String.fromCharCode(...random))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const raw  = `mrd_live_${b64}`
  const hash = await sha256Hex(raw)
  return { raw, hash }
}

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function thisMonth() { return new Date().toISOString().slice(0, 7) }   // "2026-05"

export async function getKeyByHash(env, hash) {
  return env.MERIDIAN_KEYS.get(`key:${hash}`, 'json')
}

export async function putKey(env, hash, record) {
  await env.MERIDIAN_KEYS.put(`key:${hash}`, JSON.stringify(record))
  if (record.customer_id) {
    await env.MERIDIAN_KEYS.put(`customer:${record.customer_id}`, hash)
  }
}

export async function getHashByCustomer(env, customer_id) {
  return env.MERIDIAN_KEYS.get(`customer:${customer_id}`, 'text')
}

// Validate a raw "Authorization: Bearer mrd_live_..." header. On success,
// increments calls_this_month and writes back. Resets the counter when the
// month rolls over. Race conditions on the increment are tolerated — at
// monthly-quota scale a few lost counts won't matter.
export async function validateAndTouch(env, rawKey) {
  if (!rawKey?.startsWith('mrd_live_')) return { ok: false, code: 401, error: 'invalid key format' }
  const hash = await sha256Hex(rawKey)
  const rec  = await getKeyByHash(env, hash)
  if (!rec)         return { ok: false, code: 401, error: 'unknown key' }
  if (!rec.active)  return { ok: false, code: 401, error: 'key inactive (subscription canceled?)' }

  const now = thisMonth()
  if (rec.month_start !== now) {
    rec.month_start      = now
    rec.calls_this_month = 0
  }
  if (rec.calls_this_month >= rec.monthly_limit) {
    return { ok: false, code: 429, error: `monthly quota exhausted (${rec.monthly_limit} calls)` }
  }
  rec.calls_this_month += 1
  rec.last_used_at = new Date().toISOString()
  await putKey(env, hash, rec)
  return { ok: true, record: rec, hash, calls_remaining: rec.monthly_limit - rec.calls_this_month }
}
