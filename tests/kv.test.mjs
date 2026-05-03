// _kv.js: thin wrapper around env.MERIDIAN_KEYS. Tests use a fake KV
// instead of a real Cloudflare binding — same surface, no I/O.

import { test } from 'node:test'
import assert  from 'node:assert/strict'
import { hasKV, kvGet, kvPut, kvDelete, kvIncr } from '../landing/functions/api/_kv.js'

function fakeKV() {
  const store = new Map()
  return {
    store,
    binding: {
      get(key, type) {
        const v = store.get(key)
        if (v == null) return Promise.resolve(null)
        if (type === 'json') {
          try { return Promise.resolve(JSON.parse(v)) } catch { return Promise.resolve(null) }
        }
        return Promise.resolve(v)
      },
      put(key, value /* , opts */) {
        store.set(key, value)
        return Promise.resolve()
      },
      delete(key) { store.delete(key); return Promise.resolve() },
    },
  }
}

test('hasKV true only when env.MERIDIAN_KEYS is bound', () => {
  assert.equal(hasKV({}), false)
  assert.equal(hasKV(null), false)
  assert.equal(hasKV(undefined), false)
  assert.equal(hasKV({ MERIDIAN_KEYS: { get() {}, put() {} } }), true)
})

test('kvGet returns null when unbound', async () => {
  assert.equal(await kvGet({}, 'whatever'), null)
})

test('kvGet text + json round-trip', async () => {
  const { binding, store } = fakeKV()
  store.set('a', 'hello')
  store.set('b', JSON.stringify({ n: 42 }))
  const env = { MERIDIAN_KEYS: binding }
  assert.equal(await kvGet(env, 'a'),         'hello')
  assert.deepEqual(await kvGet(env, 'b', 'json'), { n: 42 })
  assert.equal(await kvGet(env, 'missing'),   null)
})

test('kvPut stringifies non-strings', async () => {
  const { binding, store } = fakeKV()
  const env = { MERIDIAN_KEYS: binding }
  await kvPut(env, 's', 'plain')
  await kvPut(env, 'o', { x: 1, nested: [1, 2] })
  await kvPut(env, 'n', 99)
  assert.equal(store.get('s'), 'plain')
  assert.equal(store.get('o'), '{"x":1,"nested":[1,2]}')
  assert.equal(store.get('n'), '99')
})

test('kvPut + ttlSeconds is forwarded', async () => {
  let captured
  const env = { MERIDIAN_KEYS: { put(k, v, opts) { captured = opts; return Promise.resolve() } } }
  await kvPut(env, 'k', 'v', 60)
  assert.deepEqual(captured, { expirationTtl: 60 })
})

test('kvDelete is a no-op when unbound', async () => {
  await kvDelete({}, 'k')   // shouldn't throw
})

test('kvIncr counts up from 0 and writes the new value', async () => {
  const { binding } = fakeKV()
  const env = { MERIDIAN_KEYS: binding }
  assert.equal(await kvIncr(env, 'counter'), 1)
  assert.equal(await kvIncr(env, 'counter'), 2)
  assert.equal(await kvIncr(env, 'counter'), 3)
  assert.equal(await kvGet(env, 'counter'), '3')
})

test('kvIncr returns 0 when unbound', async () => {
  assert.equal(await kvIncr({}, 'k'), 0)
})
