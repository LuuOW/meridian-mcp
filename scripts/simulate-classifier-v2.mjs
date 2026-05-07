#!/usr/bin/env node
// Dry-run of proposed orbital-classifier retune. Does NOT modify
// production code. Reads scripts/calibration-panel.mjs and runs it
// through both:
//   • the current orbital.mjs (imported as-is)
//   • a v2 reimplementation in this file with the proposed formula
//     changes — described below
// then prints a side-by-side delta so we can decide whether to land
// the retune before touching mcp/_lib/orbital.mjs.
//
// Proposed changes (implementation lives in this file, not in production):
//   1. Renormalize mass — log-scaled across realistic LLM body lengths
//      [200, 3000] chars and [3, 12] keywords. Today's formula
//      saturates near 1.0 for the longer bodies Llama-3.3-70B emits.
//   2. Renormalize scope — drop the 0.25 floor; let kws + cross_domain
//      span [0,1].
//   3. Tighten planet score — switch from product to min(mass, scope,
//      independence)^1.5 so a deficit on any single axis disqualifies
//      planet, instead of letting two strong axes drown out a missing one.
//   4. Loosen asteroid threshold — Math.max(0, 0.55 - p.mass) instead
//      of 0.4, so smaller-but-real skills register.
//   5. Decouple wavelength — pull in independence + lagrange_potential
//      so the deep-blue/violet end (380–470 nm) is reachable. Today's
//      formula is mass-dominated and clusters at 600 nm.
//
// Run: node scripts/simulate-classifier-v2.mjs

import { tokenize, uniq }            from '../mcp/_lib/tokenize.mjs'
import { SYSTEM_TERMS }                from '../mcp/_lib/systems.mjs'
import { orbitalClassify as classifyV1 } from '../mcp/_lib/orbital.mjs'
import { TASK, panelForClassify, PANEL } from './calibration-panel.mjs'

// ── v2 helpers ──────────────────────────────────────────────────────
function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }
function r3(x) { return Math.round(x * 1000) / 1000 }
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

const CLASS_BOOST = {
  planet: 1.30, trojan: 1.20, irregular: 1.10,
  moon: 1.05, asteroid: 0.85, comet: 0.80,
}

// ── v2 physicsOf ────────────────────────────────────────────────────
// CHANGED: mass renormalised against [200, 3000] char bodies and [3, 12]
// keyword counts. The old formula saturated near 1.0 for the longer,
// keyword-richer outputs Llama-3.3-70B produces today.
// CHANGED: scope drops the 0.25 floor and uses a higher saturation point.
// CHANGED: wavelength is no longer a one-axis function of mass.
function physicsOfV2(skill, sibTokens) {
  const desc  = (skill.description || '').toLowerCase()
  const body  = (skill.body || '').toLowerCase()
  const kws   = (skill.keywords || []).map(k => String(k).toLowerCase())
  const kwSet = new Set(kws)
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  // mass — calibrated to current LLM output stats
  const BODY_LO = 200, BODY_HI = 3000
  const KW_LO = 3, KW_HI = 12
  const lenN = clamp(
    (Math.log10(Math.max(50, body.length)) - Math.log10(BODY_LO)) /
    (Math.log10(BODY_HI) - Math.log10(BODY_LO)),
  )
  const kwN = clamp((kws.length - KW_LO) / (KW_HI - KW_LO))
  const mass = clamp(0.6 * lenN + 0.4 * kwN)

  const sysAffinity = {}
  for (const [sys, terms] of Object.entries(SYSTEM_TERMS)) {
    let hits = 0
    for (const t of tokens) if (terms.has(t)) hits++
    sysAffinity[sys] = clamp(hits / 6)
  }
  const dominant = Object.entries(sysAffinity).reduce((a, b) => a[1] > b[1] ? a : b)[0]
  const sysVec   = Object.values(sysAffinity)
  const sysSum   = sysVec.reduce((s, v) => s + v, 0) || 1
  const sysProbs = sysVec.map(v => v / sysSum)
  const H = -sysProbs.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0)
  const cross_domain = clamp(H / Math.log(3))

  const top2 = sysVec.slice().sort((a, b) => b - a)
  const lagrange_potential = clamp(Math.min(top2[0], top2[1]) * 1.4)

  // scope — drop 0.25 floor; saturation at kws/12 instead of kws/14
  const scope = clamp(Math.min(0.7, kws.length / 12) + cross_domain * 0.3)

  let bestTokSim = 0, bestKwSim = 0
  for (const sib of sibTokens) {
    if (sib.skill === skill) continue
    const inter = sib.toks.reduce((n, t) => n + (tokens.includes(t) ? 1 : 0), 0)
    const union = new Set([...tokens, ...sib.toks]).size
    const j = union ? inter / union : 0
    if (j > bestTokSim) bestTokSim = j

    const sibKws = new Set((sib.skill.keywords || []).map(k => String(k).toLowerCase()))
    if (sibKws.size && kwSet.size) {
      let ki = 0
      for (const k of kwSet) if (sibKws.has(k)) ki++
      const ku = new Set([...kwSet, ...sibKws]).size
      const kj = ku ? ki / ku : 0
      if (kj > bestKwSim) bestKwSim = kj
    }
  }
  const dep_ratio = clamp(Math.max(bestTokSim * 1.5, bestKwSim * 2.2))

  const independence = clamp(1 - dep_ratio * 0.7 + mass * 0.2)

  const lens = kws.map(k => k.length)
  const meanL = lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length)
  const sdL   = Math.sqrt(lens.reduce((s, x) => s + (x - meanL) ** 2, 0) / Math.max(1, lens.length))
  const fragmentation = clamp(sdL / 8 + cross_domain * 0.4)

  const longWords = kws.filter(k => k.includes('-') || k.length >= 12).length
  const drag = clamp(longWords / Math.max(2, kws.length) * 0.7 + cross_domain * 0.2)

  const semi_major_axis = r3(1 + (1 - 0.5 * mass - 0.3 * scope - 0.2 * independence) * 6)
  const eccentricity    = r3(clamp(Math.abs(mass - scope) * 0.85 + drag * 0.3, 0, 0.95))
  const inclination     = r3(cross_domain * (Math.PI / 2))
  const orbital_period  = r3(Math.pow(semi_major_axis, 1.5))
  const perihelion      = r3(semi_major_axis * (1 - eccentricity))
  const aphelion        = r3(semi_major_axis * (1 + eccentricity))
  const slugHash        = hashStr(skill.slug || '')
  const mean_anomaly    = r3(((slugHash % 1000) / 1000) * 2 * Math.PI)

  // wavelength — heavy + isolated → red end; cross-domain + drag → blue end.
  // Sweep is two-dimensional now, so the full visible band (380–750 nm)
  // is reachable by extreme inputs in either direction.
  const redPull  = 0.55 * mass + 0.25 * independence + 0.10 * lagrange_potential
  const bluePull = 0.55 * cross_domain + 0.30 * fragmentation + 0.20 * drag
  const wavelength = Math.round(clamp(
    380 + 370 * (0.5 + 0.55 * (redPull - bluePull)),
    380, 750,
  ))

  const polarization = r3(clamp(1 - fragmentation, 0, 1))
  const amplitude    = r3(mass)
  const phaseHash    = hashStr(`${skill.slug || ''}|${(body || '').slice(0, 64)}`)
  const phase        = r3(((phaseHash % 1000) / 1000) * 2 * Math.PI)

  return {
    mass, scope, independence, cross_domain,
    fragmentation, drag, dep_ratio,
    lagrange_potential,
    star_system: dominant,
    star_affinity: sysAffinity,
    orbital: { semi_major_axis, eccentricity, inclination,
               orbital_period, perihelion, aphelion, mean_anomaly },
    optical: { wavelength, polarization, amplitude, phase },
  }
}

// ── v2 classOf ──────────────────────────────────────────────────────
// CHANGED: planet uses min(mass, scope, independence)^1.5 so a deficit
// on any single axis disqualifies it.
// CHANGED: asteroid threshold raised from 0.4 to 0.55.
function classOfV2(p, hasParentInSet) {
  const planet_score   = Math.min(p.mass, p.scope, p.independence) ** 1.5
  const moon_score     = Math.max(0, 0.5 - p.independence) * 2
                         * (hasParentInSet ? 1 : 0.4)
                         * (1 - 0.5 * p.mass)
  const trojan_score   = p.dep_ratio * (hasParentInSet ? 1 : 0.5) * (1 - p.fragmentation)
  const asteroid_score = Math.max(0, 0.55 - p.mass) * 2.5 * p.scope * p.independence
  const comet_score    = p.drag * p.cross_domain * (1 - p.dep_ratio)
  const irregular_score= p.cross_domain * p.fragmentation * 0.85

  const candidates = {
    planet: planet_score, moon: moon_score, trojan: trojan_score,
    asteroid: asteroid_score, comet: comet_score, irregular: irregular_score,
  }
  let cls = 'asteroid', best = -1
  for (const [k, v] of Object.entries(candidates)) {
    if (v > best) { best = v; cls = k }
  }
  return { cls, scores: candidates }
}

// ── v2 orbitalClassify (full pipeline copy, using v2 helpers) ───────
function classifyV2(skills, task) {
  const enriched = skills.map(s => ({
    skill: s,
    toks: uniq([
      ...tokenize(s.description),
      ...tokenize(s.body),
      ...(s.keywords || []).flatMap(k => tokenize(k)),
    ]),
  }))

  const physics = enriched.map(({ skill }) => physicsOfV2(skill, enriched))

  const parents = enriched.map(({ toks }, i) => {
    let best = null, bestSim = 0
    for (let j = 0; j < enriched.length; j++) {
      if (j === i) continue
      const sib  = enriched[j]
      const inter = sib.toks.reduce((n, t) => n + (toks.includes(t) ? 1 : 0), 0)
      const union = new Set([...toks, ...sib.toks]).size
      const j2 = union ? inter / union : 0
      if (j2 > bestSim) { bestSim = j2; best = sib.skill.slug }
    }
    return bestSim > 0.18 ? best : null
  })

  const taskTokens = uniq(tokenize(task))

  const classified = enriched.map(({ skill }, i) => {
    const p = physics[i]
    const parent = parents[i]
    const { cls, scores } = classOfV2(p, !!parent)

    let hits = [], desc_hits = 0, body_hits = 0, kw_hits = 0
    const kwTokens = new Set((skill.keywords || []).flatMap(k => tokenize(k)))
    const descTokens = new Set(tokenize(skill.description))
    const body = (skill.body || '').toLowerCase()
    for (const t of taskTokens) {
      const k = kwTokens.has(t),  d = descTokens.has(t),  b = body.includes(t)
      if (k) kw_hits++
      if (d) desc_hits++
      if (b) body_hits = Math.min(20, body_hits + Math.min(3, body.split(t).length - 1))
      if (k || d || b) hits.push(t)
    }

    const tokenScore = kw_hits * 10 + desc_hits * 5 + body_hits
    const diversity  = 1 + Math.max(0, hits.length - 1) * 0.12
    const classBoost = CLASS_BOOST[cls] || 1
    const versatility= 1 + Math.min(0.30, p.lagrange_potential * 0.5)
    const route_score = Number((tokenScore * diversity * classBoost * versatility).toFixed(3))

    return {
      slug: skill.slug,
      route_score,
      classification: {
        class: cls,
        class_scores: scores,
        physics: p,
        parent,
        star_system: p.star_system,
      },
    }
  })

  classified.sort((a, b) => b.route_score - a.route_score)
  return classified
}

// ── Run both classifiers on the same panel ──────────────────────────
const panel = panelForClassify()
const v1 = classifyV1(panel, TASK)
const v2 = classifyV2(panel, TASK)

// ── Metrics helpers ─────────────────────────────────────────────────
const CLASSES  = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']
const PHYSICS_AXES = ['mass', 'scope', 'independence', 'cross_domain', 'fragmentation', 'drag', 'dep_ratio']

function statsOf(values) {
  const xs = values.filter(v => Number.isFinite(v))
  if (!xs.length) return { mean: NaN, std: NaN, min: NaN, max: NaN }
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length
  return {
    mean: round(mean), std: round(Math.sqrt(variance)),
    min: round(Math.min(...xs)), max: round(Math.max(...xs)),
  }
}
function round(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x }

function summarise(ranked) {
  const dist = {}
  for (const cls of CLASSES) dist[cls] = 0
  for (const r of ranked) dist[r.classification.class] = (dist[r.classification.class] || 0) + 1

  const physics = {}
  for (const axis of PHYSICS_AXES) physics[axis] = statsOf(ranked.map(r => r.classification.physics[axis]))

  const wavelength = statsOf(ranked.map(r => r.classification.physics.optical.wavelength))

  const matches = ranked.filter(r => {
    const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
    return expected && r.classification.class === expected
  }).length
  const accuracy = round(matches / ranked.length)

  return { dist, physics, wavelength, accuracy }
}

const a = summarise(v1)
const b = summarise(v2)

// ── Output ──────────────────────────────────────────────────────────
console.log(`\nDry-run: current vs proposed v2  (panel: ${panel.length} skills, task: "${TASK}")\n`)

console.log('CLASS DISTRIBUTION              CURRENT v1   →   PROPOSED v2')
for (const cls of CLASSES) {
  const v1n = a.dist[cls] || 0
  const v2n = b.dist[cls] || 0
  const arrow = v1n === v2n ? '·' : (v2n > v1n ? '↑' : '↓')
  console.log(`  ${cls.padEnd(12)}              ${String(v1n).padStart(3)}/${panel.length}  ${arrow}      ${String(v2n).padStart(3)}/${panel.length}`)
}

console.log(`\nCLASS ACCURACY                  ${a.accuracy}        →   ${b.accuracy}`)

console.log('\nPHYSICS AXES — discriminative range (max − min)')
console.log('                                CURRENT v1   →   PROPOSED v2')
for (const axis of PHYSICS_AXES) {
  const v1d = round(a.physics[axis].max - a.physics[axis].min)
  const v2d = round(b.physics[axis].max - b.physics[axis].min)
  const arrow = Math.abs(v2d - v1d) < 0.02 ? '·' : (v2d > v1d ? '↑' : '↓')
  console.log(`  ${axis.padEnd(15)}               ${String(v1d).padStart(5)}  ${arrow}      ${String(v2d).padStart(5)}`)
}

console.log('\nPHYSICS AXES — mean ± std')
console.log('                                CURRENT v1                PROPOSED v2')
for (const axis of PHYSICS_AXES) {
  const v1s = a.physics[axis], v2s = b.physics[axis]
  console.log(`  ${axis.padEnd(15)}        ${String(v1s.mean).padStart(6)} ± ${String(v1s.std).padEnd(5)}        ${String(v2s.mean).padStart(6)} ± ${String(v2s.std).padEnd(5)}`)
}

console.log(`\nWAVELENGTH BAND                 [${a.wavelength.min}, ${a.wavelength.max}] (Δ ${round(a.wavelength.max - a.wavelength.min)} nm)   →   [${b.wavelength.min}, ${b.wavelength.max}] (Δ ${round(b.wavelength.max - b.wavelength.min)} nm)`)

// Per-skill class flips
const flips = []
for (const r2 of v2) {
  const r1 = v1.find(x => x.slug === r2.slug)
  if (r1 && r1.classification.class !== r2.classification.class) {
    flips.push({
      slug: r2.slug,
      from: r1.classification.class,
      to:   r2.classification.class,
      expected: PANEL.find(p => p.slug === r2.slug)?.__expectedClass || '?',
    })
  }
}
if (flips.length) {
  console.log(`\nCLASS FLIPS  (${flips.length} of ${panel.length})`)
  for (const f of flips) {
    const correct = f.to === f.expected ? '✓' : (f.from === f.expected ? '✗' : '·')
    console.log(`  ${correct}  ${f.slug.padEnd(32)} ${f.from.padEnd(10)} → ${f.to.padEnd(10)}   (expected: ${f.expected})`)
  }
}

console.log('\nVERDICT')
const wavelengthGood = b.wavelength.min <= 470 && b.wavelength.max >= 680
const classBalanced = b.dist.planet < panel.length * 0.5 && Object.values(b.dist).filter(n => n > 0).length >= 4
const accuracyImproved = b.accuracy > a.accuracy + 0.15
console.log(`  class distribution rebalanced  : ${classBalanced ? '✓' : '✗'}  (planet ${b.dist.planet}/${panel.length}, ${Object.values(b.dist).filter(n => n > 0).length} classes used)`)
console.log(`  class accuracy improved        : ${accuracyImproved ? '✓' : '✗'}  (${a.accuracy} → ${b.accuracy})`)
console.log(`  wavelength spans visible band  : ${wavelengthGood ? '✓' : '✗'}  ([${b.wavelength.min}, ${b.wavelength.max}] nm)`)
console.log(`  mass / scope / independence discrimination recovered :`)
const v1ms = a.physics.mass.max - a.physics.mass.min
const v2ms = b.physics.mass.max - b.physics.mass.min
console.log(`    mass         ${round(v1ms)} → ${round(v2ms)}   ${v2ms > 0.5 ? '✓' : '✗'}`)
const v1sc = a.physics.scope.max - a.physics.scope.min
const v2sc = b.physics.scope.max - b.physics.scope.min
console.log(`    scope        ${round(v1sc)} → ${round(v2sc)}   ${v2sc > 0.5 ? '✓' : '✗'}`)
const v1in = a.physics.independence.max - a.physics.independence.min
const v2in = b.physics.independence.max - b.physics.independence.min
console.log(`    independence ${round(v1in)} → ${round(v2in)}   ${v2in > 0.4 ? '✓' : '✗'}`)
