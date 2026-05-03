// Cloudflare AI Gateway routing helper.
//
// Setting env.AI_GATEWAY_ACCOUNT_ID + env.AI_GATEWAY_NAME flips inference
// calls (Groq, etc.) through the gateway URL — buys you a free dashboard
// (calls/cost/latency per route), automatic request caching, retries, and
// per-key rate limits. Unsetting either var falls back to direct calls.
//
// For Workers AI specifically, the binding accepts a `gateway: { id }` opt
// in `env.AI.run(model, input, opts)` — see workersAiGatewayOpts() below.
//
// Setup (one-time, in Cloudflare dashboard):
//   AI > AI Gateway > Create Gateway > name it "meridian"
//   then: wrangler secret put AI_GATEWAY_ACCOUNT_ID
//         wrangler secret put AI_GATEWAY_NAME

const GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1'

export function isGatewayEnabled(env) {
  return Boolean(env?.AI_GATEWAY_ACCOUNT_ID && env?.AI_GATEWAY_NAME)
}

// Returns the URL to POST to for a given upstream provider. Falls through
// to the provider's direct URL when the gateway isn't configured.
export function gatewayUrl(env, provider, providerPath) {
  if (!isGatewayEnabled(env)) {
    // Fallback to known direct URLs for providers we use.
    return DIRECT_URLS[provider] + providerPath
  }
  // CF AI Gateway expects: /v1/{account}/{gateway}/{provider}/{providerPath}
  // The providerPath is *appended* to the provider's base — e.g. for groq,
  // GW URL ends with /groq/chat/completions.
  return `${GATEWAY_BASE}/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/${provider}${providerPath}`
}

// For env.AI.run() — Workers AI binding's gateway option. Returns the
// opts object to merge into the run() call. Returns {} when disabled, so
// `env.AI.run(model, input, workersAiGatewayOpts(env))` is always safe.
export function workersAiGatewayOpts(env) {
  if (!isGatewayEnabled(env)) return {}
  return { gateway: { id: env.AI_GATEWAY_NAME } }
}

const DIRECT_URLS = {
  groq:    'https://api.groq.com/openai/v1',
  openai:  'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
}
