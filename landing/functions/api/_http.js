// Shared HTTP helpers for Cloudflare Pages Functions.
// CORS + JSON response shaping. Single source of truth — every route imports
// from here so a change to default headers or status semantics applies
// uniformly to /api/orbital-route, /api/route, /api/quota, /api/stripe/*,
// /api/skill/[slug], etc.

export function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age':       '86400',
  }
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status:  init.status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...(init.headers || {}) },
  })
}
