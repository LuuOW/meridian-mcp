// GET /api/whoami
// Returns the caller's IP as Cloudflare sees it, plus whether that IP
// matches the OWNER_IPS allowlist (so owner-bypass debugging doesn't
// require digging through Pages env vars).

import { jsonResponse, corsHeaders } from './_orbital.js'
import { isOwnerIp, prefix64, ownerEntries } from './_ip.js'

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'GET')     return jsonResponse({ error: 'GET only' }, { status: 405 })

  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const v6 = prefix64(ip)
  return jsonResponse({
    ip,
    is_ipv6: ip.includes(':'),
    prefix_v6: v6 ? `${v6}::/64` : null,
    owner: isOwnerIp(ip, env),
    allowlist_size: ownerEntries(env).length,
  })
}
