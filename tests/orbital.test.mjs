// Tests for the JS edge orbital classifier (landing/functions/api/_orbital.js).
// The Python classifier (skill_orbit.py) ships with the npm tarball and is
// covered by the existing skills.test.mjs roundtrip. This file pins:
//   1. Physics laws that must hold no matter how scoring is tuned
//      (Kepler III, perihelion/aphelion bounds, wavelength visibility, etc.)
//   2. Determinism (same slug + body → same hash-derived fields).
//   3. Sanity bounds on every signature field.
//   4. Class assignment for archetypal physics inputs.
//   5. Lagrange-potential math.
//   6. Routing pipeline integration.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  physicsOf, classOf, orbitalClassify,
  CLASS_BOOST, SYSTEM_TERMS,
} from '../landing/functions/api/_orbital.js'

const TAU = 2 * Math.PI

// ── Fixtures ────────────────────────────────────────────────────────────────
// Use realistic body content — bodies are tokenized, so 'x'.repeat(4000) would
// collapse to one giant token and skew scope/dep_ratio computations.
const planet_like = {
  slug: 'docker',
  description: 'container orchestration and image building',
  keywords: ['docker', 'container', 'image', 'build', 'deploy', 'ci/cd', 'devops', 'kubernetes', 'nginx', 'server'],
  body: ('docker is the canonical container runtime. build images with Dockerfile. deploy via registry. run containers in production with kubernetes or compose. configure nginx as ingress. setup ssh for remote build agents. integrate ci/cd pipelines. monitor with observability tooling. ').repeat(8),
}
const moon_like = {
  slug: 'docker-compose',
  description: 'multi-container docker development workflows',
  keywords: ['docker', 'container', 'compose'],
  body: 'short body about docker compose',  // short → low mass
}
const asteroid_like = {
  slug: 'css-spacing-layout',
  description: 'precise spacing and layout primitives for css',
  keywords: ['css','margin','padding','flex','grid','gap','layout','spacing'],
  body: 'short focused tool.',  // low mass, high scope, high independence
}
const cross_domain_like = {
  slug: 'partner-skill-compiler',
  description: 'compiles llm prompts into deployable container marketing campaigns',
  keywords: ['llm','prompt','docker','container','seo','campaign','content','marketing','agent'],
  body: 'mixes mind, signal, and forge terminology aggressively. '.repeat(20),
}

function buildBatch(skills) {
  return skills.map(s => ({
    skill: s,
    toks: [...new Set([
      ...(s.description || '').toLowerCase().split(/\W+/).filter(Boolean),
      ...(s.body || '').toLowerCase().split(/\W+/).filter(Boolean),
      ...(s.keywords || []).flatMap(k => String(k).toLowerCase().split(/\W+/).filter(Boolean)),
    ])],
  }))
}

// ── 1. Physics laws (must hold under any scoring tune) ──────────────────────

test('Kepler III: orbital_period === semi_major_axis^1.5 (rounded)', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const p = physicsOf(s, buildBatch([s]))
    const a = p.orbital.semi_major_axis
    const expected = Math.round(Math.pow(a, 1.5) * 1000) / 1000
    assert.equal(p.orbital.orbital_period, expected, `Kepler III broken for ${s.slug}`)
  }
})

test('perihelion + aphelion === 2 × semi_major_axis (rounded slack)', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const p = physicsOf(s, buildBatch([s]))
    const { semi_major_axis: a, perihelion: q, aphelion: Q } = p.orbital
    // Allow 0.01 slack from the r3 rounding compounding three times
    assert.ok(Math.abs((q + Q) - 2 * a) < 0.01, `q+Q=${q+Q} vs 2a=${2*a} for ${s.slug}`)
  }
})

test('perihelion <= semi_major_axis <= aphelion', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const { perihelion: q, aphelion: Q, semi_major_axis: a } = physicsOf(s, buildBatch([s])).orbital
    assert.ok(q <= a && a <= Q, `${q} <= ${a} <= ${Q} failed for ${s.slug}`)
  }
})

test('eccentricity in [0, 0.95]', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const e = physicsOf(s, buildBatch([s])).orbital.eccentricity
    assert.ok(e >= 0 && e <= 0.95, `eccentricity ${e} out of range for ${s.slug}`)
  }
})

test('inclination in [0, π/2]', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const i = physicsOf(s, buildBatch([s])).orbital.inclination
    assert.ok(i >= 0 && i <= Math.PI / 2 + 1e-3, `inclination ${i} out of range for ${s.slug}`)
  }
})

test('mean_anomaly in [0, 2π]', () => {
  const m = physicsOf(planet_like, buildBatch([planet_like])).orbital.mean_anomaly
  assert.ok(m >= 0 && m <= TAU + 1e-3)
})

test('semi_major_axis in [1, 7]', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const a = physicsOf(s, buildBatch([s])).orbital.semi_major_axis
    assert.ok(a >= 1 && a <= 7, `a=${a} out of range for ${s.slug}`)
  }
})

// ── 2. Optical bounds ───────────────────────────────────────────────────────

test('wavelength in visible range [380, 750] nm', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const w = physicsOf(s, buildBatch([s])).optical.wavelength
    assert.ok(w >= 380 && w <= 750, `wavelength ${w} out of visible for ${s.slug}`)
    assert.ok(Number.isInteger(w), `wavelength ${w} should be integer nm`)
  }
})

test('polarization in [0, 1]; amplitude in [0, 1]; phase in [0, 2π]', () => {
  const p = physicsOf(planet_like, buildBatch([planet_like])).optical
  assert.ok(p.polarization >= 0 && p.polarization <= 1)
  assert.ok(p.amplitude >= 0 && p.amplitude <= 1)
  assert.ok(p.phase >= 0 && p.phase <= TAU + 1e-3)
})

test('amplitude === mass (rounded)', () => {
  const p = physicsOf(planet_like, buildBatch([planet_like]))
  assert.equal(p.optical.amplitude, Math.round(p.mass * 1000) / 1000)
})

test('polarization === 1 - fragmentation (rounded)', () => {
  const p = physicsOf(planet_like, buildBatch([planet_like]))
  assert.equal(p.optical.polarization, Math.round((1 - p.fragmentation) * 1000) / 1000)
})

// ── 3. Determinism ──────────────────────────────────────────────────────────

test('same slug + body → identical mean_anomaly and phase', () => {
  const a = physicsOf(planet_like, buildBatch([planet_like]))
  const b = physicsOf(planet_like, buildBatch([planet_like]))
  assert.equal(a.orbital.mean_anomaly, b.orbital.mean_anomaly)
  assert.equal(a.optical.phase, b.optical.phase)
})

test('different slugs → different mean_anomaly (with overwhelming probability)', () => {
  const a = physicsOf({ ...planet_like, slug: 'alpha' }, buildBatch([planet_like])).orbital.mean_anomaly
  const b = physicsOf({ ...planet_like, slug: 'omega' }, buildBatch([planet_like])).orbital.mean_anomaly
  assert.notEqual(a, b)
})

// ── 4. Base 8-vector bounds ─────────────────────────────────────────────────

test('all base physics fields are in [0, 1]', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const p = physicsOf(s, buildBatch([s]))
    for (const field of ['mass','scope','independence','cross_domain','fragmentation','drag','dep_ratio','lagrange_potential']) {
      const v = p[field]
      assert.ok(v >= 0 && v <= 1, `${field}=${v} out of [0,1] for ${s.slug}`)
    }
  }
})

test('star_system is one of forge/signal/mind', () => {
  for (const s of [planet_like, moon_like, asteroid_like, cross_domain_like]) {
    const p = physicsOf(s, buildBatch([s]))
    assert.ok(['forge','signal','mind'].includes(p.star_system))
  }
})

// ── 5. Classification archetypes ────────────────────────────────────────────

test('hand-built physics: high m×s×i should classify as planet', () => {
  const p = { mass: 0.85, scope: 0.85, independence: 0.85, cross_domain: 0.2,
              fragmentation: 0.2, drag: 0.2, dep_ratio: 0.1 }
  const { cls } = classOf(p, false)
  assert.equal(cls, 'planet')
})

test('hand-built physics: low independence + has parent + low mass → moon', () => {
  const p = { mass: 0.3, scope: 0.4, independence: 0.2, cross_domain: 0.1,
              fragmentation: 0.1, drag: 0.1, dep_ratio: 0.5 }
  const { cls } = classOf(p, true)
  assert.equal(cls, 'moon')
})

test('hand-built physics: high dep_ratio + has parent + low fragmentation → trojan', () => {
  const p = { mass: 0.5, scope: 0.5, independence: 0.5, cross_domain: 0.1,
              fragmentation: 0.05, drag: 0.1, dep_ratio: 0.9 }
  const { cls } = classOf(p, true)
  assert.equal(cls, 'trojan')
})

test('hand-built physics: high drag + cross_domain + low dep → comet', () => {
  const p = { mass: 0.3, scope: 0.4, independence: 0.7, cross_domain: 0.85,
              fragmentation: 0.3, drag: 0.85, dep_ratio: 0.05 }
  const { cls } = classOf(p, false)
  assert.equal(cls, 'comet')
})

// ── 6. Lagrange potential math ──────────────────────────────────────────────

test('lagrange_potential is clamped(min(top2)*1.4)', () => {
  // Build a skill with measurable affinity in two systems
  const dual = {
    slug: 'dual', description: 'docker prompt llm api kubernetes',
    keywords: ['docker','prompt','llm','api','kubernetes','rag','agent'],
    body: 'mixes forge and mind systems',
  }
  const p = physicsOf(dual, buildBatch([dual]))
  const sorted = Object.values(p.star_affinity).slice().sort((a,b) => b-a)
  const expected = Math.min(1, Math.min(sorted[0], sorted[1]) * 1.4)
  assert.equal(p.lagrange_potential.toFixed(6), expected.toFixed(6))
})

test('lagrange_potential <= 1 even when top2 affinities are high', () => {
  const heavy = {
    slug: 'heavy', description: 'docker docker docker prompt prompt prompt',
    keywords: ['docker','prompt','llm','agent','rag','kubernetes','api','vector','embedding','container'],
    body: 'very heavy on both forge and mind',
  }
  const p = physicsOf(heavy, buildBatch([heavy]))
  assert.ok(p.lagrange_potential <= 1)
})

// ── 7. Class boost map sanity ───────────────────────────────────────────────

test('CLASS_BOOST has all six classes with sane values', () => {
  const expected = ['planet','moon','trojan','asteroid','comet','irregular']
  for (const c of expected) {
    assert.ok(typeof CLASS_BOOST[c] === 'number')
    assert.ok(CLASS_BOOST[c] > 0 && CLASS_BOOST[c] < 2)
  }
  assert.ok(CLASS_BOOST.planet >= CLASS_BOOST.moon, 'planet should boost more than moon')
  assert.ok(CLASS_BOOST.asteroid <= 1 && CLASS_BOOST.comet <= 1)
})

// ── 8. SYSTEM_TERMS coverage ────────────────────────────────────────────────

test('SYSTEM_TERMS has the three expected systems with non-empty term sets', () => {
  for (const sys of ['forge','signal','mind']) {
    assert.ok(SYSTEM_TERMS[sys] instanceof Set)
    assert.ok(SYSTEM_TERMS[sys].size > 10, `${sys} term set is suspiciously small`)
  }
})

// ── 9. Routing pipeline integration ─────────────────────────────────────────

test('orbitalClassify returns sorted by route_score desc', () => {
  const skills = [planet_like, moon_like, asteroid_like, cross_domain_like]
  const out = orbitalClassify(skills, 'docker container deploy')
  assert.equal(out.length, 4)
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i-1].route_score >= out[i].route_score, `not sorted at ${i}`)
  }
})

test('orbitalClassify result has expected shape per row', () => {
  const out = orbitalClassify([planet_like, moon_like], 'container')
  for (const row of out) {
    assert.ok(typeof row.slug === 'string')
    assert.ok(typeof row.route_score === 'number')
    assert.ok(row.classification && row.classification.physics)
    assert.ok(row.classification.physics.orbital)
    assert.ok(row.classification.physics.optical)
    assert.ok(typeof row.classification.decision_rule === 'string')
    assert.ok(['planet','moon','trojan','asteroid','comet','irregular'].includes(row.classification.class))
  }
})

test('habitable_zone is true iff mass in [0.4, 0.85]', () => {
  const out = orbitalClassify([planet_like, moon_like, asteroid_like, cross_domain_like], '')
  for (const row of out) {
    const m = row.classification.physics.mass
    const expected = m >= 0.4 && m <= 0.85
    assert.equal(row.classification.habitable_zone, expected, `${row.slug}: m=${m} hz=${row.classification.habitable_zone}`)
  }
})

test('docker-only query routes docker as #1', () => {
  // Use highly specific tokens that only the docker fixture has many hits on.
  const out = orbitalClassify([planet_like, moon_like, asteroid_like, cross_domain_like],
    'docker dockerfile registry kubernetes nginx ingress')
  assert.equal(out[0].slug, 'docker')
})

// ── 10. Snapshot: classification of fixture corpus ──────────────────────────
// Pins the current behavior so future formula tweaks show up as a diff.

test('moon hinge: planet wins over moon when independence > 0.5', () => {
  const p = { mass: 0.45, scope: 0.55, independence: 0.6, cross_domain: 0.1,
              fragmentation: 0.1, drag: 0.1, dep_ratio: 0.4 }
  const { cls } = classOf(p, true)
  // moon_score = max(0, 0.5-0.6)*2*1*0.775 = 0; planet wins
  assert.notEqual(cls, 'moon')
})

test('asteroid hinge: planet wins over asteroid when mass >= 0.4', () => {
  const p = { mass: 0.45, scope: 0.6, independence: 0.85, cross_domain: 0.0,
              fragmentation: 0.1, drag: 0.0, dep_ratio: 0.05 }
  const { cls } = classOf(p, false)
  // asteroid_score = max(0, 0.4-0.45)*2.5*0.6*0.85 = 0; planet wins
  assert.equal(cls, 'planet')
})

test('asteroid hinge: asteroid wins for genuinely thin skill (mass < 0.3)', () => {
  const p = { mass: 0.15, scope: 0.6, independence: 0.85, cross_domain: 0.0,
              fragmentation: 0.1, drag: 0.0, dep_ratio: 0.05 }
  const { cls } = classOf(p, false)
  // planet=0.077; asteroid=(0.4-0.15)*2.5*0.6*0.85=0.319 → asteroid
  assert.equal(cls, 'asteroid')
})

test('keyword-Jaccard dep_ratio: shared keywords lift dep_ratio meaningfully', () => {
  const a = { slug: 'a', description: 'first',  keywords: ['docker','deploy','build'], body: 'unrelated body content for skill a only.' }
  const b = { slug: 'b', description: 'second', keywords: ['docker','deploy','tag'],   body: 'totally different body for skill b alone.' }
  const out = orbitalClassify([a, b], '')
  for (const r of out) {
    // 2 shared keywords out of 4-union = 0.5 Jaccard × 2.2 amp = 1.1 → clamp to 1
    assert.ok(r.classification.physics.dep_ratio >= 0.7,
      `${r.slug} dep_ratio=${r.classification.physics.dep_ratio} should be high`)
  }
})

test('snapshot: archetype classes resolve to valid celestial bodies', () => {
  const out = orbitalClassify([planet_like, moon_like, asteroid_like, cross_domain_like], '')
  const VALID = new Set(['planet','moon','trojan','asteroid','comet','irregular'])
  for (const row of out) {
    assert.ok(VALID.has(row.classification.class),
      `${row.slug} → ${row.classification.class} is not a valid class`)
  }
  // Heavy planet_like with high mass + scope + independence should land in
  // the upper-tier classes (planet/trojan), not the rare-edge classes.
  const docker = out.find(r => r.slug === 'docker').classification.class
  assert.ok(['planet','trojan'].includes(docker),
    `docker fixture should be planet or trojan, got ${docker}`)
})
