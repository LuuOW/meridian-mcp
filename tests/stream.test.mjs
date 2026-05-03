// _stream.js: SSE response builder + iterOpenAIStream parser. Both are
// fiddly enough that a regression here would be silent and ugly.

import { test } from 'node:test'
import assert  from 'node:assert/strict'
import { sseResponse, iterOpenAIStream } from '../landing/functions/api/_stream.js'

// Helper: build a Response whose body is a single string of SSE chunks
// (handy for feeding iterOpenAIStream).
function makeSSEResponse(chunks) {
  // chunks: array of strings to emit as separate stream chunks
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

// Helper: read an entire SSE Response body to a string.
async function readBody(response) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out
}

test('sseResponse sets correct headers', () => {
  const { response } = sseResponse()
  assert.equal(response.headers.get('content-type'),  'text/event-stream; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
})

// Web-stream backpressure: Node's TransformStream has a high-water mark of 1,
// so the writer blocks indefinitely if the reader hasn't started consuming.
// Tests must launch the reader CONCURRENTLY with the writes (Promise then
// awaited at the end) — production isolates have a reader on the other end
// of the network so this is a test-harness concern, not a bug.
test('sseResponse send() formats events as event:/data: blocks', async () => {
  const { response, send, close } = sseResponse()
  const bodyPromise = readBody(response)
  await send('progress', { stage: 'connected', n: 1 })
  await send('skill',    { slug: 'foo' })
  await close()
  const body = await bodyPromise
  assert.match(body, /^event: progress\ndata: \{"stage":"connected","n":1\}\n\n/)
  assert.match(body, /event: skill\ndata: \{"slug":"foo"\}\n\n/)
})

test('sseResponse JSON-encodes values with newlines so SSE framing survives', async () => {
  const { response, send, close } = sseResponse()
  const bodyPromise = readBody(response)
  await send('skill', { body: 'line1\nline2\n## heading' })
  await close()
  const body = await bodyPromise
  // The skill body had literal newlines; after JSON encoding they
  // become \n escapes inside the data: line, so SSE framing (blank
  // line terminator) is preserved.
  assert.equal(body.split('\n\n').filter(Boolean).length, 1)
})

test('sseResponse send() after close() does not throw', async () => {
  const { send, close } = sseResponse()
  await close()
  await send('progress', { stage: 'too late' })   // swallowed silently
})

test('iterOpenAIStream yields content deltas in order', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const out = []
  for await (const d of iterOpenAIStream(makeSSEResponse(chunks))) out.push(d)
  assert.deepEqual(out, ['Hello', ' world', '!'])
})

test('iterOpenAIStream handles chunks split mid-message', async () => {
  // The stream may deliver bytes split anywhere — including in the middle
  // of a single SSE block. The parser must accumulate until a full
  // "\n\n"-terminated block is available.
  const chunks = [
    'data: {"choices":[{"delta":',
    '{"content":"split"}}]}\n',
    '\ndata: {"choices":[{"delta":{"content":"-test"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const out = []
  for await (const d of iterOpenAIStream(makeSSEResponse(chunks))) out.push(d)
  assert.deepEqual(out, ['split', '-test'])
})

test('iterOpenAIStream stops at [DONE] sentinel', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: [DONE]\n\n',
    'data: {"choices":[{"delta":{"content":"never"}}]}\n\n',  // should not be yielded
  ]
  const out = []
  for await (const d of iterOpenAIStream(makeSSEResponse(chunks))) out.push(d)
  assert.deepEqual(out, ['a'])
})

test('iterOpenAIStream skips malformed JSON without aborting', async () => {
  const chunks = [
    'data: not-json-at-all\n\n',
    'data: {"choices":[{"delta":{"content":"survived"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const out = []
  for await (const d of iterOpenAIStream(makeSSEResponse(chunks))) out.push(d)
  assert.deepEqual(out, ['survived'])
})

test('iterOpenAIStream skips empty deltas (role-only chunks etc.)', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
    'data: {"choices":[{"delta":{}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"actual"}}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const out = []
  for await (const d of iterOpenAIStream(makeSSEResponse(chunks))) out.push(d)
  assert.deepEqual(out, ['actual'])
})

test('iterOpenAIStream returns immediately if response has no body', async () => {
  const out = []
  for await (const d of iterOpenAIStream({ body: null })) out.push(d)
  assert.deepEqual(out, [])
})
