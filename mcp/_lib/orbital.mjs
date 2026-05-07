// Open-domain orbital classifier. Derives a physics signature for each
// candidate (mass, scope, independence, cross_domain, fragmentation, drag,
// dep_ratio), assigns a celestial body class, computes orbital + optical
// parameters, and scores task→candidate relevance. Domain-agnostic — a
// candidate can be a tool, prompt, document, product, or any routable
// entity.
//
// Pure JS. Runs identically in browser and Node — no bundler-only globals.

import { tokenize, uniq } from './tokenize.mjs'
import { SYSTEM_TERMS }   from './systems.mjs'

const CLASS_BOOST = {
  planet: 1.30, trojan: 1.20, irregular: 1.10,
  moon: 1.05, asteroid: 0.85, comet: 0.80,
}

function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }
function r3(x) { return Math.round(x * 1000) / 1000 }
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function physicsOf(candidate, sibTokens) {
  const desc  = (candidate.description || '').toLowerCase()
  const body  = (candidate.body || '').toLowerCase()
  const kws   = (candidate.keywords || []).map(k => String(k).toLowerCase())
  const kwSet = new Set(kws)
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  // mass — log-scaled across realistic LLM body lengths [200, 3000]
  // chars and [3, 12] keywords. The earlier formula
  // ((log10(bodyLen) − 1.7) × 0.35 + min(0.4, kws/15)) was tuned to
  // shorter bodies and saturated near 1.0 for everything Llama-3.3-70B
  // emits today. Renormalising recovers discrimination on the mass axis
  // (calibration panel: 0.35 → 0.50 dynamic range) and stops the
  // planet-bias spillover into class scoring (panel: 17/18 → 5/18 planets).
  const BODY_LO = 200, BODY_HI = 3000
  const KW_LO   = 3,   KW_HI   = 12
  const lenN = clamp(
    (Math.log10(Math.max(50, body.length)) - Math.log10(BODY_LO)) /
    (Math.log10(BODY_HI) - Math.log10(BODY_LO)),
  )
  const kwN  = clamp((kws.length - KW_LO) / (KW_HI - KW_LO))
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

  // scope — drop the 0.25 floor (was inflating every input above the
  // moon/asteroid moon-sub-0.5-independence threshold). Saturation
  // moves from kws/14 → kws/12 to widen the usable band.
  const scope = clamp(Math.min(0.7, kws.length / 12) + cross_domain * 0.3)

  let bestTokSim = 0, bestKwSim = 0
  for (const sib of sibTokens) {
    if (sib.candidate === candidate) continue
    const inter = sib.toks.reduce((n, t) => n + (tokens.includes(t) ? 1 : 0), 0)
    const union = new Set([...tokens, ...sib.toks]).size
    const j = union ? inter / union : 0
    if (j > bestTokSim) bestTokSim = j

    const sibKws = new Set((sib.candidate.keywords || []).map(k => String(k).toLowerCase()))
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
  const slugHash        = hashStr(candidate.slug || '')
  const mean_anomaly    = r3(((slugHash % 1000) / 1000) * 2 * Math.PI)

  // wavelength — heavy + isolated → red end; cross-domain + drag →
  // blue end. The previous formula (380 + mass·370 − drag·100 −
  // cross_domain·50) was monotonically dominated by mass and clustered
  // at 600 nm because mass·370 ≥ 110 made the deep-violet band
  // structurally unreachable. Two-axis pull recovers the full visible
  // band on extreme inputs while leaving "average" candidates mid-band.
  const redPull  = 0.55 * mass + 0.25 * independence + 0.10 * lagrange_potential
  const bluePull = 0.55 * cross_domain + 0.30 * fragmentation + 0.20 * drag
  const wavelength = Math.round(clamp(
    380 + 370 * (0.5 + 0.55 * (redPull - bluePull)),
    380, 750,
  ))
  const polarization    = r3(clamp(1 - fragmentation, 0, 1))
  const amplitude       = r3(mass)
  const phaseHash       = hashStr(`${candidate.slug || ''}|${(body || '').slice(0, 64)}`)
  const phase           = r3(((phaseHash % 1000) / 1000) * 2 * Math.PI)

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

export { CLASS_BOOST, SYSTEM_TERMS }

export function classOf(p, hasParentInSet) {
  // Planet uses min(mass, scope, independence)^1.5 instead of the
  // product. The product let two strong axes drown out a missing one
  // (a long body with sparse keywords still beat planet's 0.4 floor);
  // min penalises the deficit, which is what "anchor candidate" actually
  // means semantically — strong on every dimension, not just on average.
  const planet_score   = Math.min(p.mass, p.scope, p.independence) ** 1.5
  const moon_score     = Math.max(0, 0.5 - p.independence) * 2
                         * (hasParentInSet ? 1 : 0.4)
                         * (1 - 0.5 * p.mass)
  const trojan_score   = p.dep_ratio * (hasParentInSet ? 1 : 0.5) * (1 - p.fragmentation)
  // Asteroid threshold raised from 0.4 → 0.55 to match the new (lower-
  // saturation) mass distribution. Without this, niche/small candidates
  // never cleared the threshold because mass had drifted up across
  // the whole panel under the old saturation.
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

function decisionRule(cls, p, parent, systems) {
  const sys = p.star_system
  const cdSystems = systems.filter(s => p.star_affinity[s] >= 0.25)
  switch (cls) {
    case 'planet':
      return `Domain anchor in the ${sys} system — high mass (${p.mass.toFixed(2)}) × scope (${p.scope.toFixed(2)}) × independence (${p.independence.toFixed(2)}). Loads as a primary candidate.`
    case 'moon':
      return `Satellite of ${parent ? parent + ' ' : 'a parent candidate'}— low independence (${p.independence.toFixed(2)}). Co-loads with its parent.`
    case 'trojan':
      return `Companion at L4/L5 of ${parent ? parent + ' ' : 'a parent candidate'}— high dep_ratio (${p.dep_ratio.toFixed(2)}), low fragmentation. Co-activates permanently.`
    case 'asteroid':
      return `Narrow-scope niche entry — low mass (${p.mass.toFixed(2)}) but independently useful. Loaded only when explicitly relevant.`
    case 'comet':
      return `Occasional / specialized candidate — high drag (${p.drag.toFixed(2)}) × cross_domain (${p.cross_domain.toFixed(2)}). Triggers on rare task profiles.`
    case 'irregular':
      return `Cross-domain bridge — spans ${cdSystems.join(' ↔ ') || 'multiple systems'}. High fragmentation, useful for hybrid tasks.`
  }
  return ''
}

export function orbitalClassify(candidates, task) {
  const enriched = candidates.map(s => ({
    candidate: s,
    toks: uniq([
      ...tokenize(s.description),
      ...tokenize(s.body),
      ...(s.keywords || []).flatMap(k => tokenize(k)),
    ]),
  }))

  const physics = enriched.map(({ candidate }) => physicsOf(candidate, enriched))

  const parents = enriched.map(({ toks }, i) => {
    let best = null, bestSim = 0
    for (let j = 0; j < enriched.length; j++) {
      if (j === i) continue
      const sib  = enriched[j]
      const inter = sib.toks.reduce((n, t) => n + (toks.includes(t) ? 1 : 0), 0)
      const union = new Set([...toks, ...sib.toks]).size
      const j2 = union ? inter / union : 0
      if (j2 > bestSim) { bestSim = j2; best = sib.candidate.slug }
    }
    return bestSim > 0.18 ? best : null
  })

  const taskTokens = uniq(tokenize(task))

  const classified = enriched.map(({ candidate }, i) => {
    const p = physics[i]
    const parent = parents[i]
    const { cls, scores } = classOf(p, !!parent)

    let hits = [], desc_hits = 0, body_hits = 0, kw_hits = 0
    const kwTokens = new Set((candidate.keywords || []).flatMap(k => tokenize(k)))
    const descTokens = new Set(tokenize(candidate.description))
    const body = (candidate.body || '').toLowerCase()
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

    const systems = Object.keys(SYSTEM_TERMS)
    const lagrange_systems = systems.filter(s => p.star_affinity[s] >= 0.25)

    return {
      slug:        candidate.slug,
      name:        candidate.name || candidate.slug,
      description: candidate.description,
      body:        candidate.body || '',
      keywords:    candidate.keywords || [],
      route_score,
      classification: {
        class:              cls,
        class_scores:       scores,
        physics:            p,
        parent,
        star_system:        p.star_system,
        lagrange_systems,
        lagrange_potential: p.lagrange_potential,
        decision_rule:      decisionRule(cls, p, parent, systems),
        habitable_zone:     p.mass >= 0.4 && p.mass <= 0.85,
        tidal_lock:         cls === 'trojan' || (cls === 'moon' && p.dep_ratio > 0.55),
      },
      breakdown: {
        kw_hits, desc_hits, body_hits,
        diversity_mult: Number(diversity.toFixed(2)),
        class_mult:     Number(classBoost.toFixed(2)),
        lagrange_mult:  Number(versatility.toFixed(2)),
        tokens:         hits,
      },
      hits: { keywords: kw_hits, description: desc_hits, body: body_hits, tokens: hits },
      why: explainRoute({ kw_hits, desc_hits, body_hits, cls, classBoost, versatility, hits, parent }),
    }
  })

  classified.sort((a, b) => b.route_score - a.route_score)
  return classified
}

function explainRoute({ kw_hits, desc_hits, body_hits, cls, classBoost, versatility, hits, parent }) {
  const parts = []
  if (kw_hits)   parts.push(`${kw_hits} keyword`)
  if (desc_hits) parts.push(`${desc_hits} desc`)
  if (body_hits) parts.push(`${body_hits} body`)
  let line = parts.join(' · ')
  line += ` · ${cls}×${classBoost.toFixed(2)}`
  if (versatility > 1.01) line += ` · L×${versatility.toFixed(2)}`
  if (parent) line += ` · parent=${parent}`
  if (hits.length) line += ` · "${hits.slice(0, 5).join(', ')}"`
  return line
}
