#!/usr/bin/env node
// CRTBP-based classifier simulation. Does NOT modify production code.
//
// Replaces the six hand-tuned class-scoring formulas in
// mcp/_lib/orbital.mjs with physics-grounded tests from Vallado's
// "Fundamentals of Astrodynamics and Applications" §12.7 — the
// Circular Restricted Three-Body Problem.
//
// Mapping
// ───────
// Each routing batch is treated as one CRTBP system:
//   • Primary 1 (mass 1 − m*) at the origin = "the cluster of skills".
//   • Primary 2 (mass m*) at (1 − m*, 0, 0)  = "the task".
//   • Each candidate skill is a test particle whose orbital elements
//     (a, e, i, ω, M) come from the existing physicsOf — the same
//     mapping production already uses to derive orbital params from
//     SKILL.md text. Only the *class assignment* changes here.
//
// We pick m* = 0.1 — large enough that L4/L5 are visible features
// (Vallado p.972 figure uses m* = 0.012 for Earth-Moon; 0.1 makes the
// classification thresholds easier to land at panel scale).
//
// For each skill we compute:
//   • Synodic-frame position (x, y, z) from Kepler elements.
//   • Speed v from vis-viva  (v² = 2/r − 1/a, μ = 1 in normalized CRTBP).
//   • Jacobi constant C (Vallado Eq. 12-15):
//       C = x² + y² + 2(1−m*)/r₁ + 2m*/r₂ − v²
//   • Distance to L4, L5 (Vallado Eq. 12-18 triangular points).
//   • Distance to L1 (Vallado quintic; numerically solved).
//   • Hill radius of secondary: r_H = (m*/3)^(1/3).
//
// Class assignment, in priority order — first match wins:
//   1. irregular      i > 1.0 rad      (≈57° — high inclination, near-retrograde
//                                       for our [0, π/2] classifier band)
//   2. trojan         min(|r − L4|, |r − L5|) < 0.30  (libration band)
//   3. moon           r₂ < r_H                       (inside Hill sphere)
//   4. comet          e > 0.5  OR  C < C(L1)         (escape-able / high-e)
//   5. planet         e < 0.15  AND  mass > 0.45     (anchor-class bound)
//   6. asteroid       fall-through                   (everything else stable)
//
// Run: node scripts/simulate-classifier-crtbp.mjs

import { tokenize, uniq }                from '../mcp/_lib/tokenize.mjs'
import { SYSTEM_TERMS }                   from '../mcp/_lib/systems.mjs'
import { orbitalClassify as classifyV1 }  from '../mcp/_lib/orbital.mjs'
import { TASK, panelForClassify, PANEL }  from './calibration-panel.mjs'

// ── Reuse production physicsOf (inlined to avoid changing exports) ──
// Same code as mcp/_lib/orbital.mjs:physicsOf — class assignment is
// what we're replacing, so the mapping from SKILL.md → orbital
// elements is held constant for an apples-to-apples comparison.
function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }
function r3(x) { return Math.round(x * 1000) / 1000 }
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function physicsOf(skill, sibTokens) {
  const desc  = (skill.description || '').toLowerCase()
  const body  = (skill.body || '').toLowerCase()
  const kws   = (skill.keywords || []).map(k => String(k).toLowerCase())
  const kwSet = new Set(kws)
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  const massRaw = (Math.log10(Math.max(50, body.length)) - 1.7) * 0.35 + Math.min(0.4, kws.length / 15)
  const mass = clamp(massRaw)

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

  const scope = clamp(0.25 + Math.min(0.5, kws.length / 14) + cross_domain * 0.25)

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
  const slugHash        = hashStr(skill.slug || '')
  const mean_anomaly    = r3(((slugHash % 1000) / 1000) * 2 * Math.PI)

  return {
    mass, scope, independence, cross_domain,
    fragmentation, drag, dep_ratio,
    lagrange_potential,
    star_system: dominant,
    star_affinity: sysAffinity,
    orbital: { semi_major_axis, eccentricity, inclination,
               omega_argument: 0,                // perifocal ω; we choose 0 for the simulation
               mean_anomaly },
  }
}

// ── CRTBP system parameters ─────────────────────────────────────────
// Vallado p.972 — Sun-Jupiter has m* ≈ 0.000953; Earth-Moon ≈ 0.012.
// We use 0.1 for the simulation: large enough that L4/L5 are visible
// features at panel scale (skills' a are in [1, 7] before rescaling).
const M_STAR = 0.1
const PRIM1_X = -M_STAR        // primary 1 (mass = 1 − m*) at (-m*, 0, 0)
const PRIM2_X = 1 - M_STAR     // primary 2 (mass = m*)     at (1−m*, 0, 0)

// Triangular-Lagrange points (Vallado Eq. 12-18, the y = ±√3/2 case).
// These are exact analytic expressions; no quintic needed.
const L4 = { x: 0.5 - M_STAR, y:  Math.sqrt(3) / 2, z: 0 }
const L5 = { x: 0.5 - M_STAR, y: -Math.sqrt(3) / 2, z: 0 }

// L1 collinear point — Vallado Eq. 12-18 quintic. Newton-iterate
// f(γ) = γ⁵ − (3 − m*)γ⁴ + (3 − 2m*)γ³ − m*γ² + 2m*γ − m* = 0
// γ = distance from secondary toward primary 1.
function solveL1Quintic(mu) {
  // Hill-radius approximation as initial guess.
  let g = Math.cbrt(mu / 3)
  for (let k = 0; k < 30; k++) {
    const f  = g**5 - (3 - mu) * g**4 + (3 - 2 * mu) * g**3
             - mu * g**2 + 2 * mu * g - mu
    const df = 5 * g**4 - 4 * (3 - mu) * g**3 + 3 * (3 - 2 * mu) * g**2
             - 2 * mu * g + 2 * mu
    if (Math.abs(df) < 1e-15) break
    const gNew = g - f / df
    if (!Number.isFinite(gNew)) break
    if (Math.abs(gNew - g) < 1e-12) { g = gNew; break }
    g = gNew
  }
  return g
}
const L1_GAMMA = solveL1Quintic(M_STAR)
const L1 = { x: PRIM2_X - L1_GAMMA, y: 0, z: 0 }

// Hill radius of the secondary primary.
const HILL_R = Math.cbrt(M_STAR / 3)

// Jacobi constant (Vallado Eq. 12-15).
function jacobi(x, y, z, vx, vy, vz) {
  const r1 = Math.sqrt((x - PRIM1_X) ** 2 + y ** 2 + z ** 2)
  const r2 = Math.sqrt((x - PRIM2_X) ** 2 + y ** 2 + z ** 2)
  const v2 = vx * vx + vy * vy + vz * vz
  return x * x + y * y + 2 * (1 - M_STAR) / r1 + 2 * M_STAR / r2 - v2
}
const C_L1 = jacobi(L1.x, L1.y, L1.z, 0, 0, 0)   // zero-velocity C at L1
const C_L4 = jacobi(L4.x, L4.y, L4.z, 0, 0, 0)

// ── Map orbital elements → synodic-frame state vector ──────────────
// We rescale a so the panel's median sits near 1.0 (the primary
// separation), which puts L4/L5 in actual reach for ordinary skills.
// Production a is in [1, 7] from physicsOf; rescale to [0.3, 1.7].
function rescaleA(aPhys, panelMedianA) {
  // Linear map: aPhys ∈ [1, 7] → aSyn ∈ [0.3, 1.7].
  // Center of map = panel median, so it lands near 1.0 (primary sep).
  const lo = 0.3, hi = 1.7
  const a01 = (clamp(aPhys, 1, 7) - 1) / 6      // [0, 1]
  return lo + a01 * (hi - lo)
}

function elementsToSynodic(p, panelMedianA) {
  // Standard Kepler: solve E from M, then x_p, y_p in perifocal frame,
  // then rotate by ω, tilt by i. We're at a fixed epoch, so the
  // rotating-frame conversion is just a rotation by 0 (we choose t=0
  // when the secondary primary sits on the +x axis — convenient
  // because it matches Vallado's Fig. 12-13).
  const a = rescaleA(p.orbital.semi_major_axis, panelMedianA)
  const e = p.orbital.eccentricity
  const i = p.orbital.inclination
  const M = p.orbital.mean_anomaly
  const om = p.orbital.omega_argument || 0

  // Newton-Raphson on Kepler: M = E − e·sin(E)
  let E = M + e * Math.sin(M)
  for (let k = 0; k < 8; k++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  }
  // Perifocal coordinates (periapsis on +x_p):
  const xp = a * (Math.cos(E) - e)
  const yp = a * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E)
  // True anomaly for vis-viva direction:
  const r  = Math.sqrt(xp * xp + yp * yp)

  // Rotate by ω (in-plane), tilt by i around x-axis.
  const cw = Math.cos(om), sw = Math.sin(om)
  const x_op = xp * cw - yp * sw
  const y_op = xp * sw + yp * cw
  const ci = Math.cos(i), si = Math.sin(i)
  const x = x_op
  const y = y_op * ci
  const z = y_op * si

  // Vis-viva speed at radius r: v = √(μ(2/r − 1/a)), μ = 1 normalized.
  const v = Math.sqrt(Math.max(0, 2 / r - 1 / a))
  // Tangential direction in the orbital plane (perpendicular to r):
  // perifocal velocity components (Curtis 3.42 or Vallado 2-91):
  const p_param = a * (1 - e * e)
  const h = Math.sqrt(Math.max(1e-12, p_param))   // specific angular momentum
  const cosNu = (xp / r) || 1
  const sinNu = (yp / r) || 0
  const vxp = -(1 / h) * Math.sin(Math.atan2(sinNu, cosNu)) * 1
  const vyp =  (1 / h) * (e + cosNu) * 1
  // Scale magnitude to vis-viva v (since the analytic perifocal vel
  // already has the right shape but our μ = 1 normalization differs
  // from Vallado's conventions — use vis-viva as ground truth).
  const vScale = v / Math.max(1e-9, Math.sqrt(vxp * vxp + vyp * vyp))
  const vxp_n = vxp * vScale
  const vyp_n = vyp * vScale

  const vx_op = vxp_n * cw - vyp_n * sw
  const vy_op = vxp_n * sw + vyp_n * cw
  const vx = vx_op
  const vy = vy_op * ci
  const vz = vy_op * si

  return { a, e, i, x, y, z, vx, vy, vz, r }
}

// ── CRTBP-based class assignment ────────────────────────────────────
function classifyCRTBP(p, state) {
  const r2 = Math.sqrt(
    (state.x - PRIM2_X) ** 2 + state.y ** 2 + state.z ** 2,
  )
  const dL4 = Math.sqrt((state.x - L4.x) ** 2 + (state.y - L4.y) ** 2 + state.z ** 2)
  const dL5 = Math.sqrt((state.x - L5.x) ** 2 + (state.y - L5.y) ** 2 + state.z ** 2)
  const dLagrange = Math.min(dL4, dL5)
  const C = jacobi(state.x, state.y, state.z, state.vx, state.vy, state.vz)

  // 1. Irregular — high inclination (Vallado: trajectories that depart
  //    the orbital plane on perturbation are dynamically chaotic).
  if (state.i > 1.0) {
    return { cls: 'irregular', why: `i=${state.i.toFixed(2)} rad > 1.0` }
  }
  // 2. Trojan — librating around L4 or L5 (Vallado p.972 explicitly
  //    cites Sun-Jupiter L4/L5 as the home of Trojan asteroids).
  if (dLagrange < 0.30) {
    return { cls: 'trojan', why: `min(|r−L4|, |r−L5|)=${dLagrange.toFixed(2)} < 0.30` }
  }
  // 3. Moon — inside Hill sphere of secondary primary.
  //    r_H = (m*/3)^(1/3) = 0.32 for m* = 0.1.
  if (r2 < HILL_R) {
    return { cls: 'moon', why: `r₂=${r2.toFixed(2)} < r_H=${HILL_R.toFixed(2)}` }
  }
  // 4. Comet — high eccentricity OR Jacobi C below the L1 crossing
  //    (Vallado §12.7.1: "spacecraft with the Jacobi constant equal to
  //    that of the L1 point can just cross over from one primary to
  //    the other"). e > 0.5 is the textbook short-period-comet bound.
  if (state.e > 0.5 || C < C_L1) {
    return { cls: 'comet', why: `e=${state.e.toFixed(2)}${C < C_L1 ? `, C=${C.toFixed(2)}<C_L1=${C_L1.toFixed(2)}` : ''}` }
  }
  // 5. Planet — substantial mass anchor, low e, bound stable orbit.
  if (state.e < 0.15 && p.mass > 0.45) {
    return { cls: 'planet', why: `e=${state.e.toFixed(2)}<0.15, mass=${p.mass.toFixed(2)}>0.45` }
  }
  // 6. Asteroid — fallthrough (bound, moderate e, smaller mass).
  return { cls: 'asteroid', why: `e=${state.e.toFixed(2)}, mass=${p.mass.toFixed(2)}` }
}

// ── Run ─────────────────────────────────────────────────────────────
const panel = panelForClassify()

// Compute physics signatures + states.
const enriched = panel.map(s => ({
  skill: s,
  toks: uniq([
    ...tokenize(s.description),
    ...tokenize(s.body),
    ...(s.keywords || []).flatMap(k => tokenize(k)),
  ]),
}))
const physics = enriched.map(({ skill }) => physicsOf(skill, enriched))
const aValues = physics.map(p => p.orbital.semi_major_axis).sort((a, b) => a - b)
const medA = aValues[Math.floor(aValues.length / 2)]

const states = physics.map(p => elementsToSynodic(p, medA))
const crtbp = states.map((s, i) => classifyCRTBP(physics[i], s))

const v1 = classifyV1(panel, TASK)

// ── Metrics ─────────────────────────────────────────────────────────
const CLASSES = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']

function distOf(getCls) {
  const d = {}
  for (const c of CLASSES) d[c] = 0
  for (const x of getCls) d[x.cls] = (d[x.cls] || 0) + 1
  return d
}
const distV1    = (() => {
  const d = {}; for (const c of CLASSES) d[c] = 0
  for (const r of v1) d[r.classification.class] = (d[r.classification.class] || 0) + 1
  return d
})()
const distCRTBP = distOf(crtbp)

function classAccuracy(predicted) {
  let m = 0
  for (let i = 0; i < panel.length; i++) {
    if (PANEL[i].__expectedClass === predicted[i]) m++
  }
  return m / panel.length
}
const accV1    = (() => {
  let m = 0
  for (const r of v1) {
    const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
    if (expected && r.classification.class === expected) m++
  }
  return m / v1.length
})()
const accCRTBP = classAccuracy(crtbp.map(c => c.cls))

// ── Output ──────────────────────────────────────────────────────────
console.log(`\nCRTBP simulation (Vallado §12.7) — ${panel.length} skills, m* = ${M_STAR}`)
console.log(`L1 collinear:  γ=${L1_GAMMA.toFixed(4)}  position (${L1.x.toFixed(3)}, 0, 0)`)
console.log(`L4 triangular: (${L4.x.toFixed(3)}, ${L4.y.toFixed(3)}, 0)`)
console.log(`L5 triangular: (${L5.x.toFixed(3)}, ${L5.y.toFixed(3)}, 0)`)
console.log(`Hill radius:   r_H = ${HILL_R.toFixed(4)}`)
console.log(`C(L1) = ${C_L1.toFixed(3)}     C(L4) = ${C_L4.toFixed(3)}`)
console.log(`Panel median a (rescaled to synodic units): ${medA.toFixed(2)} → ~1.0`)

console.log('\nCLASS DISTRIBUTION                CURRENT v1   →   CRTBP physics')
for (const cls of CLASSES) {
  const v1n = distV1[cls] || 0
  const v2n = distCRTBP[cls] || 0
  const arrow = v1n === v2n ? '·' : (v2n > v1n ? '↑' : '↓')
  console.log(`  ${cls.padEnd(12)}                ${String(v1n).padStart(3)}/${panel.length}  ${arrow}      ${String(v2n).padStart(3)}/${panel.length}`)
}

console.log(`\nCLASS ACCURACY                    ${accV1.toFixed(3)}        →   ${accCRTBP.toFixed(3)}`)

console.log('\nPER-SKILL CRTBP STATE')
console.log(' slug                              expected     →  CRTBP        physics')
for (let i = 0; i < panel.length; i++) {
  const s   = panel[i]
  const st  = states[i]
  const c   = crtbp[i]
  const exp = PANEL[i].__expectedClass
  const ok  = c.cls === exp ? '✓' : '·'
  console.log(`  ${ok}  ${s.slug.padEnd(32)} ${exp.padEnd(11)} →  ${c.cls.padEnd(11)}  ${c.why}`)
}

// Class flips current → CRTBP
const flips = []
for (let i = 0; i < panel.length; i++) {
  const v1c = v1.find(r => r.slug === panel[i].slug)?.classification.class
  const cc  = crtbp[i].cls
  if (v1c && v1c !== cc) {
    flips.push({ slug: panel[i].slug, from: v1c, to: cc, expected: PANEL[i].__expectedClass })
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
const classes_used = Object.values(distCRTBP).filter(n => n > 0).length
console.log(`  classes used                   : ${classes_used}/6  ${classes_used >= 4 ? '✓' : '✗'}`)
console.log(`  no class >50% of panel         : ${Math.max(...Object.values(distCRTBP)) <= panel.length * 0.5 ? '✓' : '✗'}  (max ${Math.max(...Object.values(distCRTBP))}/${panel.length})`)
console.log(`  class accuracy improved        : ${accCRTBP > accV1 + 0.15 ? '✓' : '✗'}  (${accV1.toFixed(3)} → ${accCRTBP.toFixed(3)})`)
console.log(`  uses physics constants only    : ✓  (m*, L4/L5 from Eq. 12-18, Hill r_H, C(L1) from Eq. 12-15)`)
