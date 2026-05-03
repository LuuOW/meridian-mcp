// _vector.js: embeddings + (optional) Vectorize wrapper. Tests focus on
// cosine() numerical correctness + the binding-presence guards.

import { test } from 'node:test'
import assert  from 'node:assert/strict'
import {
  hasEmbeddings, hasVectorize, embedTexts, cosine,
  vectorizeUpsert, vectorizeQuery,
} from '../landing/functions/api/_vector.js'

test('hasEmbeddings reflects env.AI presence', () => {
  assert.equal(hasEmbeddings({}), false)
  assert.equal(hasEmbeddings({ AI: { run() {} } }), true)
  assert.equal(hasEmbeddings(null), false)
})

test('hasVectorize reflects env.VECTORIZE presence', () => {
  assert.equal(hasVectorize({}), false)
  assert.equal(hasVectorize({ VECTORIZE: { upsert() {}, query() {} } }), true)
  assert.equal(hasVectorize(null), false)
})

test('cosine identity: a·a / |a|² = 1', () => {
  const v = new Float32Array([1, 2, 3, 4])
  assert.equal(Math.abs(cosine(v, v) - 1) < 1e-6, true)
})

test('cosine of orthogonal vectors is 0', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([0, 1, 0])
  assert.equal(cosine(a, b), 0)
})

test('cosine of opposite vectors is -1', () => {
  const a = new Float32Array([1, 2, 3])
  const b = new Float32Array([-1, -2, -3])
  assert.equal(Math.abs(cosine(a, b) + 1) < 1e-6, true)
})

test('cosine handles known small case', () => {
  // a=(1,0), b=(1,1): cos = 1 / sqrt(2) ≈ 0.7071
  const a = new Float32Array([1, 0])
  const b = new Float32Array([1, 1])
  assert.equal(Math.abs(cosine(a, b) - Math.SQRT1_2) < 1e-6, true)
})

test('cosine returns 0 for length mismatch / null', () => {
  assert.equal(cosine(null, new Float32Array([1])), 0)
  assert.equal(cosine(new Float32Array([1]), null), 0)
  assert.equal(cosine(new Float32Array([1, 2]), new Float32Array([1])), 0)
})

test('cosine returns 0 for zero vector (no NaN leak)', () => {
  const z = new Float32Array([0, 0, 0])
  const v = new Float32Array([1, 2, 3])
  assert.equal(cosine(z, v), 0)
  assert.equal(cosine(v, z), 0)
})

test('embedTexts returns [] when env.AI is absent', async () => {
  assert.deepEqual(await embedTexts({}, ['hi']), [])
  assert.deepEqual(await embedTexts(null, ['hi']), [])
})

test('embedTexts returns [] for empty input', async () => {
  const env = { AI: { run() { throw new Error('should not be called') } } }
  assert.deepEqual(await embedTexts(env, []), [])
  assert.deepEqual(await embedTexts(env, null), [])
})

test('embedTexts wraps Workers AI bge-m3 response into Float32Arrays', async () => {
  let called
  const env = { AI: { run(model, input) {
    called = { model, input }
    // Workers AI response shape for bge-m3
    return Promise.resolve({
      data:  [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]],
      shape: [2, 3],
    })
  }}}
  const out = await embedTexts(env, ['a', 'b'])
  assert.equal(called.model, '@cf/baai/bge-m3')
  assert.deepEqual(called.input, { text: ['a', 'b'] })
  assert.equal(out.length, 2)
  assert.equal(out[0] instanceof Float32Array, true)
  assert.equal(out[0].length, 3)
  assert.equal(Math.abs(out[0][0] - 0.1) < 1e-6, true)
})

test('vectorizeUpsert is a no-op when binding absent', async () => {
  assert.equal(await vectorizeUpsert({}, [{ id: 'x', values: [1] }]), null)
})

test('vectorizeUpsert stringifies typed arrays + forwards items', async () => {
  let captured
  const env = { VECTORIZE: { upsert(items) { captured = items; return Promise.resolve('ok') } } }
  await vectorizeUpsert(env, [
    { id: 'a', values: new Float32Array([0.1, 0.2]), metadata: { slug: 'a' } },
    { id: 'b', values: [0.3, 0.4],                   metadata: { slug: 'b' } },
  ])
  assert.equal(captured.length, 2)
  assert.equal(captured[0].id, 'a')
  // Float32Array converted to plain array
  assert.equal(Array.isArray(captured[0].values), true)
  assert.equal(Math.abs(captured[0].values[0] - 0.1) < 1e-6, true)
  assert.equal(captured[1].id, 'b')
  assert.deepEqual(captured[0].metadata, { slug: 'a' })
})

test('vectorizeUpsert swallows binding errors (best-effort upsert)', async () => {
  const env = { VECTORIZE: { upsert() { return Promise.reject(new Error('boom')) } } }
  // Must not throw; returns null on caught error
  assert.equal(await vectorizeUpsert(env, [{ id: 'x', values: [1] }]), null)
})

test('vectorizeQuery returns [] when binding absent', async () => {
  assert.deepEqual(await vectorizeQuery({}, [0.1]), [])
})

test('vectorizeQuery returns matches array from binding', async () => {
  const env = { VECTORIZE: { query: (v, opts) => Promise.resolve({ matches: [
    { id: 'a', score: 0.9, metadata: { slug: 'a' } },
    { id: 'b', score: 0.7, metadata: { slug: 'b' } },
  ]}) }}
  const out = await vectorizeQuery(env, [0.1, 0.2], 2)
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 'a')
})

test('vectorizeQuery swallows binding errors', async () => {
  const env = { VECTORIZE: { query() { return Promise.reject(new Error('boom')) } } }
  assert.deepEqual(await vectorizeQuery(env, [0.1]), [])
})
