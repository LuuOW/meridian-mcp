import { test } from 'node:test'
import assert  from 'node:assert/strict'

import { parseFrontmatter, keywordsOf } from '../src/skill-md.mjs'

test('parseFrontmatter: simple key/value', () => {
  const { frontmatter, body } = parseFrontmatter(`---
name: foo
description: a tool
---
the body`)
  assert.equal(frontmatter.name, 'foo')
  assert.equal(frontmatter.description, 'a tool')
  assert.equal(body, 'the body')
})

test('parseFrontmatter: inline JSON array keywords', () => {
  const { frontmatter } = parseFrontmatter(`---
name: x
keywords: ["alpha", "beta", "gamma"]
---
body`)
  assert.deepEqual(frontmatter.keywords, ['alpha','beta','gamma'])
})

test('parseFrontmatter: inline JSON array with single quotes is tolerated', () => {
  const { frontmatter } = parseFrontmatter(`---
name: x
keywords: ['alpha', 'beta']
---
body`)
  assert.deepEqual(frontmatter.keywords, ['alpha','beta'])
})

test('parseFrontmatter: block-style list keywords', () => {
  const { frontmatter } = parseFrontmatter(`---
name: x
keywords:
  - alpha
  - beta
  - gamma
description: after the list
---
body`)
  assert.deepEqual(frontmatter.keywords, ['alpha','beta','gamma'])
  assert.equal(frontmatter.description, 'after the list')
})

test('parseFrontmatter: colon-in-value preserved', () => {
  const { frontmatter } = parseFrontmatter(`---
description: deploy to https://example.com path
---
body`)
  assert.equal(frontmatter.description, 'deploy to https://example.com path')
})

test('parseFrontmatter: surrounding quotes stripped', () => {
  const { frontmatter } = parseFrontmatter(`---
description: "quoted value"
name: 'single quoted'
---
body`)
  assert.equal(frontmatter.description, 'quoted value')
  assert.equal(frontmatter.name, 'single quoted')
})

test('parseFrontmatter: missing block returns empty fm + raw body', () => {
  const md = 'no frontmatter here, just text'
  const { frontmatter, body } = parseFrontmatter(md)
  assert.deepEqual(frontmatter, {})
  assert.equal(body, md)
})

test('parseFrontmatter: empty/non-string returns sane default', () => {
  assert.deepEqual(parseFrontmatter(null), { frontmatter: {}, body: '' })
  assert.deepEqual(parseFrontmatter(undefined), { frontmatter: {}, body: '' })
  assert.deepEqual(parseFrontmatter(''), { frontmatter: {}, body: '' })
})

test('keywordsOf: handles array, comma-string, and missing', () => {
  assert.deepEqual(keywordsOf({ keywords: ['a','b'] }),    ['a','b'])
  assert.deepEqual(keywordsOf({ keywords: 'a, b, c' }),    ['a','b','c'])
  assert.deepEqual(keywordsOf({ keywords: '' }),           [])
  assert.deepEqual(keywordsOf({}),                          [])
  assert.deepEqual(keywordsOf(null),                        [])
})

test('parseFrontmatter: ignores garbage lines in the block', () => {
  const { frontmatter } = parseFrontmatter(`---
name: x
# this is a comment line
description: y
---
body`)
  assert.equal(frontmatter.name, 'x')
  assert.equal(frontmatter.description, 'y')
})

test('parseFrontmatter: trailing newline after closing fence ok', () => {
  const { frontmatter, body } = parseFrontmatter(`---
name: x
---
body line
`)
  assert.equal(frontmatter.name, 'x')
  assert.equal(body, 'body line')
})
