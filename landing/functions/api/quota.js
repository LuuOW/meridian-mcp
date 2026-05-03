// GET /api/quota
// Returns the caller's current quota state.
//   Anonymous (no Authorization header) → free tier per-IP daily counter
//   Bearer mrd_live_…                  → paid plan with monthly counter

import { sha256Hex, getKeyByHash, planLimits, thisMonth } from './stripe/_keys.js'
import { jsonResponse, corsHeaders } from './_orbital.js'
import { isOwnerIp } from './_ip.js'

const FREE_DAILY = 5

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return jsonResponse({ error: 'GET only' }, { status: 405 })

  const auth = request.headers.get('authorization') || ''
  if (auth.startsWith('Bearer ')) {
    if (!env.MERIDIAN_KEYS) return jsonResponse({ error: 'KV not bound' }, { status: 503 })
    const token = auth.slice(7).trim()
    if (!token.startsWith('mrd_live_')) return jsonResponse({ error: 'invalid key format' }, { status: 401 })
    const hash = await sha256Hex(token)
    const rec  = await getKeyByHash(env, hash)
    if (!rec)         return jsonResponse({ error: 'unknown key' }, { status: 401 })
    if (!rec.active)  return jsonResponse({ error: 'key inactive' }, { status: 401 })

    // Roll over month if needed (no write — pure read endpoint)
    const calls_this_month = rec.month_start === thisMonth() ? rec.calls_this_month : 0
    return jsonResponse({
      plan:           rec.plan,
      monthly_limit:  rec.monthly_limit,
      calls_this_month,
      remaining:      Math.max(0, rec.monthly_limit - calls_this_month),
      pct_used:       Math.round(100 * calls_this_month / rec.monthly_limit),
      month_start:    rec.month_start,
    })
  }

  // Anonymous
  if (!env.MERIDIAN_KEYS) {
    return jsonResponse({ plan: 'free', daily_limit: FREE_DAILY, calls_today: 0, remaining: FREE_DAILY, kv_unbound: true })
  }
  const ip    = request.headers.get('cf-connecting-ip') || 'unknown'
  const owner = isOwnerIp(ip, env)
  const day   = new Date().toISOString().slice(0, 10)
  const dkey  = `free:${ip}:${day}`
  const cur   = parseInt(await env.MERIDIAN_KEYS.get(dkey), 10) || 0
  return jsonResponse({
    plan:        'free',
    daily_limit: FREE_DAILY,
    calls_today: cur,
    remaining:   owner ? 'unlimited' : Math.max(0, FREE_DAILY - cur),
    pct_used:    owner ? 0 : Math.round(100 * cur / FREE_DAILY),
    owner,
    day,
  })
}
