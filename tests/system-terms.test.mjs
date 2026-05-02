// Verifies landing/functions/api/_systems.js stays in sync with the canonical
// galaxy/system-terms.json. The JSON is the single source of truth across
// languages — Python's skill_orbit.py also reads it (with the option to add
// multi-word phrases that the JS tokenizer can't match).

import { test } from 'node:test'
import assert  from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SYSTEM_TERMS } from '../landing/functions/api/_systems.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = JSON.parse(readFileSync(join(ROOT, 'galaxy', 'system-terms.json'), 'utf8'))

test('JSON has the three expected systems', () => {
  for (const sys of ['forge','signal','mind']) {
    assert.ok(Array.isArray(json[sys]), `json.${sys} should be an array`)
    assert.ok(json[sys].length > 10)
  }
})

test('JS module exports a Set per system matching the JSON exactly', () => {
  for (const sys of ['forge','signal','mind']) {
    const jsSet   = SYSTEM_TERMS[sys]
    const jsonSet = new Set(json[sys])
    assert.ok(jsSet instanceof Set, `${sys} should be a Set`)

    const onlyJs   = [...jsSet].filter(t => !jsonSet.has(t))
    const onlyJson = [...jsonSet].filter(t => !jsSet.has(t))
    assert.deepEqual(onlyJs,   [], `${sys}: terms only in JS module: ${onlyJs.join(', ')}`)
    assert.deepEqual(onlyJson, [], `${sys}: terms only in JSON: ${onlyJson.join(', ')}`)
  }
})

test('all JSON terms are single-token (no whitespace)', () => {
  // Multi-word phrases live only in Python (where the tokenizer can match
  // them). The shared JSON must be JS-tokenizer-compatible.
  for (const sys of ['forge','signal','mind']) {
    for (const t of json[sys]) {
      assert.ok(!/\s/.test(t), `${sys} term "${t}" contains whitespace; only single-token terms allowed in shared JSON`)
    }
  }
})
