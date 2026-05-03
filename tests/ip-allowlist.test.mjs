// Tests for landing/functions/api/_ip.js — owner-IP allowlist with IPv6
// /64 prefix support. The whole point of /64 matching is that residential
// IPv6 addresses rotate within their subnet; the allowlist must not
// require re-entry on every rotation.

import { test } from 'node:test'
import assert  from 'node:assert/strict'

import { isOwnerIp, expandV6, prefix64, ownerEntries } from '../landing/functions/api/_ip.js'

const env = (s) => ({ OWNER_IPS: s })

test('expandV6: full form is normalized lowercase + zero-padded', () => {
  assert.equal(expandV6('2803:9810:3E2E:4210:45D6:477A:4B3A:155D'),
                       '2803:9810:3e2e:4210:45d6:477a:4b3a:155d')
})

test('expandV6: compressed :: expands to 8 groups', () => {
  assert.equal(expandV6('2803:9810::1'), '2803:9810:0000:0000:0000:0000:0000:0001')
  assert.equal(expandV6('::1'),          '0000:0000:0000:0000:0000:0000:0000:0001')
  assert.equal(expandV6('fe80::'),       'fe80:0000:0000:0000:0000:0000:0000:0000')
})

test('expandV6: rejects malformed input', () => {
  assert.equal(expandV6('not-an-ip'), null)
  assert.equal(expandV6('192.168.1.1'), null)
  assert.equal(expandV6('1::2::3'), null)             // double ::
  assert.equal(expandV6('1:2:3:4:5:6:7:8:9'), null)   // 9 groups
  assert.equal(expandV6('1:2:3:4:5:6:7'), null)       // 7 groups, no ::
})

test('prefix64: returns first 4 groups of expanded IPv6', () => {
  assert.equal(prefix64('2803:9810:3e2e:4210:45d6:477a:4b3a:155d'), '2803:9810:3e2e:4210')
  assert.equal(prefix64('2803:9810:3e2e:4210::1'),                  '2803:9810:3e2e:4210')
  assert.equal(prefix64('192.168.1.1'), null)
})

test('isOwnerIp: empty allowlist always returns false', () => {
  assert.equal(isOwnerIp('1.2.3.4',         env('')),   false)
  assert.equal(isOwnerIp('2001:db8::1',     env('')),   false)
  assert.equal(isOwnerIp('1.2.3.4',         env('  ')), false)
  assert.equal(isOwnerIp('1.2.3.4',         {}),        false)
})

test('isOwnerIp: rejects unknown IP marker', () => {
  assert.equal(isOwnerIp('unknown', env('1.2.3.4, 2001:db8::1')), false)
  assert.equal(isOwnerIp('',        env('1.2.3.4')),              false)
  assert.equal(isOwnerIp(null,      env('1.2.3.4')),              false)
})

test('isOwnerIp: exact IPv4 match', () => {
  assert.equal(isOwnerIp('203.0.113.42', env('203.0.113.42')), true)
  assert.equal(isOwnerIp('203.0.113.43', env('203.0.113.42')), false)
})

test('isOwnerIp: comma-separated multi-entry allowlist', () => {
  const e = env(' 1.1.1.1 ,  2.2.2.2 , 3.3.3.3 ')
  assert.equal(isOwnerIp('1.1.1.1', e), true)
  assert.equal(isOwnerIp('2.2.2.2', e), true)
  assert.equal(isOwnerIp('3.3.3.3', e), true)
  assert.equal(isOwnerIp('4.4.4.4', e), false)
})

test('isOwnerIp: IPv6 /64 prefix match — same subnet, different host', () => {
  // OWNER_IPS holds the originally-set address; the user's IPv6 has rotated
  // within the same /64. The new address must still match.
  const e = env('2803:9810:3e2e:4210:45d6:477a:4b3a:155d')
  assert.equal(isOwnerIp('2803:9810:3e2e:4210:45d6:477a:4b3a:155d', e), true) // exact
  assert.equal(isOwnerIp('2803:9810:3e2e:4210:abcd:ef01:2345:6789', e), true) // rotated host bits
  assert.equal(isOwnerIp('2803:9810:3e2e:4210::1',                    e), true) // compressed
  assert.equal(isOwnerIp('2803:9810:3e2e:4211:0000:0000:0000:0001',  e), false) // adjacent /64
  assert.equal(isOwnerIp('2001:db8::1',                              e), false) // unrelated network
})

test('isOwnerIp: case-insensitive IPv6 match', () => {
  const e = env('2803:9810:3E2E:4210::')
  assert.equal(isOwnerIp('2803:9810:3e2e:4210:1::', e), true)
  assert.equal(isOwnerIp('2803:9810:3E2E:4210:1::', e), true)
})

test('isOwnerIp: mixed IPv4 + IPv6 allowlist', () => {
  const e = env('203.0.113.42, 2803:9810:3e2e:4210::')
  assert.equal(isOwnerIp('203.0.113.42',                   e), true)
  assert.equal(isOwnerIp('2803:9810:3e2e:4210:dead:beef::', e), true)
  assert.equal(isOwnerIp('2001:db8::1',                    e), false)
  assert.equal(isOwnerIp('203.0.113.43',                   e), false)
})

test('ownerEntries: trims, drops empties, preserves order', () => {
  assert.deepEqual(ownerEntries(env('a, b ,, c , ')), ['a', 'b', 'c'])
  assert.deepEqual(ownerEntries(env('')), [])
  assert.deepEqual(ownerEntries({}), [])
})
