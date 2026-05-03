// _ai-gateway.js: routes Groq + Workers AI through Cloudflare AI Gateway
// when env vars are set. Tests verify both fall-through (direct URL) and
// gateway-prefixed paths.

import { test } from 'node:test'
import assert  from 'node:assert/strict'
import { isGatewayEnabled, gatewayUrl, workersAiGatewayOpts } from '../landing/functions/api/_ai-gateway.js'

test('isGatewayEnabled requires both env vars', () => {
  assert.equal(isGatewayEnabled({}), false)
  assert.equal(isGatewayEnabled({ AI_GATEWAY_ACCOUNT_ID: 'a' }), false)
  assert.equal(isGatewayEnabled({ AI_GATEWAY_NAME: 'b' }), false)
  assert.equal(isGatewayEnabled({ AI_GATEWAY_ACCOUNT_ID: 'a', AI_GATEWAY_NAME: 'b' }), true)
  assert.equal(isGatewayEnabled(null), false)
  assert.equal(isGatewayEnabled(undefined), false)
})

test('gatewayUrl falls through to provider direct URL when disabled', () => {
  assert.equal(
    gatewayUrl({}, 'groq', '/chat/completions'),
    'https://api.groq.com/openai/v1/chat/completions',
  )
  assert.equal(
    gatewayUrl({}, 'openai', '/chat/completions'),
    'https://api.openai.com/v1/chat/completions',
  )
  assert.equal(
    gatewayUrl({}, 'anthropic', '/messages'),
    'https://api.anthropic.com/v1/messages',
  )
})

test('gatewayUrl prefixes with gateway base when enabled', () => {
  const env = { AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_NAME: 'meridian' }
  assert.equal(
    gatewayUrl(env, 'groq', '/chat/completions'),
    'https://gateway.ai.cloudflare.com/v1/acct123/meridian/groq/chat/completions',
  )
  assert.equal(
    gatewayUrl(env, 'openai', '/chat/completions'),
    'https://gateway.ai.cloudflare.com/v1/acct123/meridian/openai/chat/completions',
  )
})

test('workersAiGatewayOpts returns {} when disabled', () => {
  assert.deepEqual(workersAiGatewayOpts({}),         {})
  assert.deepEqual(workersAiGatewayOpts(null),       {})
  assert.deepEqual(workersAiGatewayOpts(undefined),  {})
})

test('workersAiGatewayOpts returns {gateway:{id}} when enabled', () => {
  const env = { AI_GATEWAY_ACCOUNT_ID: 'acct123', AI_GATEWAY_NAME: 'meridian' }
  assert.deepEqual(workersAiGatewayOpts(env), { gateway: { id: 'meridian' } })
})
