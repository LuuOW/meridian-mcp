// Open-domain orbital classifier — JS port of the celestial-mechanics
// classification rules used by skill_orbit.py, generalised to handle
// arbitrary LLM-generated skills (no curated skill_weights table needed).
//
// Pipeline:
//   1. From raw skill content (description, keywords, body), derive a
//      physics signature: mass, scope, independence, cross_domain,
//      fragmentation, drag, dep_ratio (vs. its siblings in the set).
//   2. Compute per-class scores (planet/moon/trojan/asteroid/comet/irregular).
//   3. Assign class = argmax. Auto-generate a decision_rule explaining why.
//   4. Star system membership inferred from keyword overlap with
//      forge / signal / mind term sets (taken verbatim from skill_orbit.py).
//   5. Lagrange potential: if a skill has comparable affinity to >=2 systems.
//   6. Route against task: lexical+IDF × class boost × lagrange boost.

import { tokenize, uniq } from './_tokenize.js'
import { SYSTEM_TERMS }   from './_systems.js'

const CLASS_BOOST = {
  planet: 1.30, trojan: 1.20, irregular: 1.10,
  moon: 1.05, asteroid: 0.85, comet: 0.80,
}

function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }
function r3(x) { return Math.round(x * 1000) / 1000 }
// djb2 hash — deterministic, fast, 32-bit
function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

// ── PHASE 1: derive physics signature for one skill ──────────────────────
export function physicsOf(skill, sibTokens) {
  const desc  = (skill.description || '').toLowerCase()
  const body  = (skill.body || '').toLowerCase()
  const text  = `${desc} ${body}`
  const kws   = (skill.keywords || []).map(k => String(k).toLowerCase())
  const kwSet = new Set(kws)
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  // mass: information density. Long bodies + many distinct keywords → heavier.
  // Calibrated for the LLM-batch use case (5 fresh skills with ~500–1500 char
  // bodies). Note: when run on the curated SKILL.md corpus (~5–15kB bodies)
  // mass saturates at 1.0 for nearly every entry — that audit case is not the
  // classifier's intended distribution.
  const bodyLen = body.length
  const massRaw = (Math.log10(Math.max(50, bodyLen)) - 1.7) * 0.35 + Math.min(0.4, kws.length / 15)
  const mass = clamp(massRaw)

  // System affinity per star system
  const sysAffinity = {}
  let totalAffinity = 0
  for (const [sys, terms] of Object.entries(SYSTEM_TERMS)) {
    let hits = 0
    for (const t of tokens) if (terms.has(t)) hits++
    sysAffinity[sys] = clamp(hits / 6)   // 6 hits → full affinity
    totalAffinity += sysAffinity[sys]
  }

  // Dominant system + cross_domain (entropy-ish across systems)
  const dominant = Object.entries(sysAffinity).reduce((a, b) => a[1] > b[1] ? a : b)[0]
  const sysVec   = Object.values(sysAffinity)
  const sysSum   = sysVec.reduce((s, v) => s + v, 0) || 1
  const sysProbs = sysVec.map(v => v / sysSum)
  // Normalised Shannon entropy → 0=single system, 1=perfectly split across all 3
  const H = -sysProbs.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0)
  const cross_domain = clamp(H / Math.log(3))

  // Lagrange potential: skills with strong affinity in ≥2 systems
  const top2 = sysVec.slice().sort((a, b) => b - a)
  const lagrange_potential = clamp(Math.min(top2[0], top2[1]) * 1.4)

  // scope: keyword count + diversity
  const scope = clamp(0.25 + Math.min(0.5, kws.length / 14) + cross_domain * 0.25)

  // dep_ratio: similarity to other skills in the same batch.
  // We take the max of (a) full-text token Jaccard and (b) keyword-set Jaccard.
  // Keyword Jaccard is a much stronger relatedness signal — siblings sharing
  // 3+ keywords are clearly related even if their bodies use different prose.
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
  // Amplify because Jaccard tops out low. Keyword Jaccard gets a stronger
  // multiplier since it's the cleaner signal.
  const dep_ratio = clamp(Math.max(bestTokSim * 1.5, bestKwSim * 2.2))

  // independence: inverse of dep_ratio, modulated by mass (heavy ⇒ independent)
  const independence = clamp(1 - dep_ratio * 0.7 + mass * 0.2)

  // fragmentation: how scattered the keyword length distribution is
  const lens = kws.map(k => k.length)
  const meanL = lens.reduce((s, x) => s + x, 0) / Math.max(1, lens.length)
  const sdL   = Math.sqrt(lens.reduce((s, x) => s + (x - meanL) ** 2, 0) / Math.max(1, lens.length))
  const fragmentation = clamp(sdL / 8 + cross_domain * 0.4)

  // drag: presence of specialized / heavy terminology (long words, hyphens)
  const longWords = kws.filter(k => k.includes('-') || k.length >= 12).length
  const drag = clamp(longWords / Math.max(2, kws.length) * 0.7 + cross_domain * 0.2)

  // ── Orbital dynamics — derived from the base 8-vector ───────────────────
  // Semi-major axis (AU-like, [1, 7]): heavy + broad + independent skills sit
  // closer to the star. Lagrange-potential is intentionally NOT a term here —
  // L1-L5 points sit *between* bodies, not in the outer system, so versatile
  // skills shouldn't be pushed outward. L-potential stays as its own pill.
  const semi_major_axis = r3(
    1 + (1 - 0.5 * mass - 0.3 * scope - 0.2 * independence) * 6
  )
  // Eccentricity ([0, 0.95]): mismatch between depth and breadth → elongated orbit.
  const eccentricity    = r3(clamp(Math.abs(mass - scope) * 0.85 + drag * 0.3, 0, 0.95))
  // Inclination (radians, [0, π/2]): cross-domain skills sit off the ecliptic.
  const inclination     = r3(cross_domain * (Math.PI / 2))
  // Kepler's third law — T² = a³, so T = a^(3/2). Period in arbitrary years.
  const orbital_period  = r3(Math.pow(semi_major_axis, 1.5))
  // Closest / farthest approach to the central star.
  const perihelion      = r3(semi_major_axis * (1 - eccentricity))
  const aphelion        = r3(semi_major_axis * (1 + eccentricity))
  // Mean anomaly (radians, [0, 2π]): "where on its orbit" — deterministic from slug.
  const slugHash        = hashStr(skill.slug || '')
  const mean_anomaly    = r3(((slugHash % 1000) / 1000) * 2 * Math.PI)

  // ── Optical properties ──────────────────────────────────────────────────
  // Wavelength (nm, visible 380–750): heavy/dense → red, scattered/cross-domain → violet.
  const wavelength      = Math.round(Math.max(380, Math.min(750,
    380 + mass * 370 - drag * 100 - cross_domain * 50)))
  // Polarization ([0, 1]): coherence — inverse of fragmentation.
  const polarization    = r3(clamp(1 - fragmentation, 0, 1))
  // Amplitude ([0, 1]): intrinsic intensity = information density.
  const amplitude       = r3(mass)
  // Phase (radians, [0, 2π]): deterministic temporal offset from slug + body head.
  const phaseHash       = hashStr(`${skill.slug || ''}|${(body || '').slice(0, 64)}`)
  const phase           = r3(((phaseHash % 1000) / 1000) * 2 * Math.PI)

  return {
    mass, scope, independence, cross_domain,
    fragmentation, drag, dep_ratio,
    lagrange_potential,
    star_system: dominant,
    star_affinity: sysAffinity,
    orbital: {
      semi_major_axis, eccentricity, inclination,
      orbital_period, perihelion, aphelion,
      mean_anomaly,
    },
    optical: {
      wavelength, polarization, amplitude, phase,
    },
  }
}

// ── PHASE 2: classify into celestial class ───────────────────────────────
export { CLASS_BOOST, SYSTEM_TERMS }
export function classOf(p, hasParentInSet) {
  // Per-class scores. Earlier versions used `(1-mass)` and `(1-independence)`
  // directly, which made asteroid/moon symmetric to planet around m=0.5/i=0.5
  // and produced bimodal classification on mid-mass skills. Switched to
  // hinge functions so asteroid only wins for *genuinely* light skills (m<0.4)
  // and moon only wins for *genuinely* dependent skills (indep<0.5).
  const planet_score   = p.mass * p.scope * p.independence
  const moon_score     = Math.max(0, 0.5 - p.independence) * 2
                         * (hasParentInSet ? 1 : 0.4)
                         * (1 - 0.5 * p.mass)
  const trojan_score   = p.dep_ratio * (hasParentInSet ? 1 : 0.5) * (1 - p.fragmentation)
  const asteroid_score = Math.max(0, 0.4 - p.mass) * 2.5 * p.scope * p.independence
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
      return `Domain anchor in the ${sys} system — high mass (${p.mass.toFixed(2)}) × scope (${p.scope.toFixed(2)}) × independence (${p.independence.toFixed(2)}). Loads as a primary skill.`
    case 'moon':
      return `Sub-skill orbiting ${parent ? parent + ' ' : 'a parent skill'}— low independence (${p.independence.toFixed(2)}). Auto-loads alongside its parent.`
    case 'trojan':
      return `Companion at L4/L5 of ${parent ? parent + ' ' : 'a parent skill'}— high dep_ratio (${p.dep_ratio.toFixed(2)}), low fragmentation. Co-activates permanently.`
    case 'asteroid':
      return `Narrow-scope niche tool — low mass (${p.mass.toFixed(2)}) but independently useful. Loaded only when explicitly relevant.`
    case 'comet':
      return `Occasional / specialized skill — high drag (${p.drag.toFixed(2)}) × cross_domain (${p.cross_domain.toFixed(2)}). Triggers on rare task profiles.`
    case 'irregular':
      return `Cross-domain bridge — spans ${cdSystems.join(' ↔ ') || 'multiple systems'}. High fragmentation, useful for hybrid tasks.`
  }
  return ''
}

// ── PHASE 3: full classify+route ─────────────────────────────────────────
export function orbitalClassify(skills, task) {
  // Pre-tokenize each skill once (used both for physics + routing)
  const enriched = skills.map(s => ({
    skill: s,
    toks: uniq([
      ...tokenize(s.description),
      ...tokenize(s.body),
      ...(s.keywords || []).flatMap(k => tokenize(k)),
    ]),
  }))

  // Two passes: physics needs sibling tokens, classification needs physics
  const physics = enriched.map(({ skill }) => physicsOf(skill, enriched))

  // Find a parent for each skill: most token-similar OTHER skill
  const parents = enriched.map(({ skill, toks }, i) => {
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

  // Score routing relevance against task
  const taskTokens = uniq(tokenize(task))

  const classified = enriched.map(({ skill, toks }, i) => {
    const p = physics[i]
    const parent = parents[i]
    const { cls, scores } = classOf(p, !!parent)

    // Token-overlap routing score (no IDF — small fluid corpus)
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

    const systems = Object.keys(SYSTEM_TERMS)
    const lagrange_systems = systems.filter(s => p.star_affinity[s] >= 0.25)

    return {
      slug:        skill.slug,
      name:        skill.slug,
      description: skill.description,
      body:        skill.body || '',
      keywords:    skill.keywords || [],
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

export { corsHeaders, jsonResponse } from './_http.js'
