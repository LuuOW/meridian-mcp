// Mirror of the UniProt accession regex used in cf-worker/worker.mjs's
// /v1/helix handler. The worker filters incoming candidates against
// this pattern before sending them to GPT-4o-mini; if the pattern drifts
// from the official UniProt spec we lose protein candidates silently,
// so this test pins the canonical accepted/rejected boundary cases.
//
// Pattern source: https://www.uniprot.org/help/accession_numbers
//   short form: P01133, Q12345, A1B234
//   long form:  A0A123BC456, A0A0B1C234

import { test } from 'node:test'
import assert from 'node:assert/strict'

const UNIPROT_RE = /^([OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$/

function valid(s) { return typeof s === 'string' && UNIPROT_RE.test(s) }

test('accepts canonical short-form accessions (P/Q/O families)', () => {
  for (const s of ['P01133', 'P21583', 'Q6UWN8', 'O00533', 'P09038']) {
    assert.ok(valid(s), `${s} should be valid`)
  }
})

test('accepts canonical short-form accessions (A-N, R-Z families)', () => {
  for (const s of ['A1B234', 'B0AAA1', 'N1ABC1', 'R1AAA1', 'Z1ZZZ1']) {
    assert.ok(valid(s), `${s} should be valid`)
  }
})

test('accepts long-form accessions (10-char, two repeating quads)', () => {
  // 10 chars total: 2-char prefix + 2 × 4-char group. Real examples
  // from UniProt's accession-number docs.
  for (const s of ['A0A0B4J2D5', 'A0A024RBG1', 'A0A0B1C234', 'B5A1B2C345']) {
    assert.ok(valid(s), `${s} should be valid`)
  }
})

test('rejects empties, nulls, non-strings', () => {
  for (const s of ['', null, undefined, 0, 12345, {}, [], false]) {
    assert.ok(!valid(s), `${JSON.stringify(s)} should be invalid`)
  }
})

test('rejects malformed strings', () => {
  for (const s of [
    'p01133',       // lowercase
    'P0',           // too short
    'P011334',      // too long for short form (7 chars)
    'P01133*',      // trailing punctuation
    ' P01133',      // leading space
    'P01133 ',      // trailing space
    'A0A123BC4567', // too long for long form (12 chars)
    '12345',        // all digits
    'P01133-1',     // isoform suffix not allowed
    'PXX133',       // letters where digits required
  ]) {
    assert.ok(!valid(s), `${JSON.stringify(s)} should be invalid`)
  }
})

test('regex anchors with ^ and $ (no embedded matches)', () => {
  // Without anchors, "garbageP01133extra" would match the substring.
  assert.ok(!valid('garbageP01133extra'), 'embedded match must be rejected')
  assert.ok(!valid('P01133extra'),         'trailing-text match must be rejected')
})
