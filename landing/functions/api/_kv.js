// Thin KV abstraction. All Cloudflare-KV-specific code goes through this
// file so a one-day migration to Upstash Redis / Vercel KV / D1 is just an
// implementation swap of the four functions below.
//
// Conventions:
//   - Pass `env` explicitly (no module-level state — Pages Functions reuse
//     isolates across requests).
//   - Type defaults to 'text'. Pass 'json' to get auto-parsed values.
//   - `ttlSeconds` is optional. KV's expirationTtl floor is 60s; the wrapper
//     accepts smaller values but Cloudflare will round up.
//   - All functions are no-ops if `env.MERIDIAN_KEYS` is unbound, returning
//     the same shape they would on a cache miss. Callers can keep working.

export function hasKV(env) {
  return Boolean(env?.MERIDIAN_KEYS)
}

export async function kvGet(env, key, type = 'text') {
  if (!hasKV(env)) return null
  return env.MERIDIAN_KEYS.get(key, type === 'json' ? 'json' : undefined)
}

export async function kvPut(env, key, value, ttlSeconds) {
  if (!hasKV(env)) return
  const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined
  const payload = typeof value === 'string' ? value : JSON.stringify(value)
  return env.MERIDIAN_KEYS.put(key, payload, opts)
}

export async function kvDelete(env, key) {
  if (!hasKV(env)) return
  return env.MERIDIAN_KEYS.delete(key)
}

// Atomic-ish counter increment with TTL. KV doesn't support real atomics,
// so this races under high concurrency — acceptable for free-tier daily
// quotas where over-counting by 1-2 is fine.
export async function kvIncr(env, key, ttlSeconds) {
  if (!hasKV(env)) return 0
  const cur = parseInt(await env.MERIDIAN_KEYS.get(key), 10) || 0
  const next = cur + 1
  await env.MERIDIAN_KEYS.put(key, String(next), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined)
  return next
}
