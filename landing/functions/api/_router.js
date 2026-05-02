// Lexical+orbital scorer used by /api/route and /api/dynamic-route.
// Token matches are weighted by IDF (rare tokens score higher), then
// boosted by orbital class (planets/trojans/moons/asteroids/comets) and
// by Lagrange potential (skills that bridge multiple star systems).
//
// This is a JS approximation of the production orbital scorer in
// skill_orbit.py — close enough for the demo, deterministic, runs in a
// Workers V8 isolate.

const STOP = new Set([
  'the','and','for','with','that','this','from','have','your','about',
  'into','what','when','where','which','their','there','these','those',
  'will','would','should','could','been','being','need','want','get',
  'set','use','using','make','made','like','also','some','any','all',
  'one','two','out','off','its',"it's",'you',"you're",'our',
])

// Class weights — match the production decision rules:
//   planet:    primary domain anchor → highest
//   trojan:    permanent companion at L4/L5 → high
//   moon:      sub-skill orbiting a planet → moderate
//   irregular: cross-domain — boosted when task spans systems
//   asteroid:  narrow scope, niche tooling → lower
//   comet:     occasional / specialized → lowest
const CLASS_BOOST = {
  planet:    1.30,
  trojan:    1.20,
  moon:      1.05,
  irregular: 1.10,
  asteroid:  0.85,
  comet:     0.80,
}

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}
function uniq(arr) { return [...new Set(arr)] }

// Score a single skill against a tokenized task.
// Returns score + the breakdown (used by the side panel "why" view).
function scoreOne(skill, taskTokens, idf) {
  const descTokens = new Set(tokenize(skill.description))
  const kwTokens   = new Set((skill.keywords || []).flatMap(k => tokenize(k)))
  const bodyText   = (skill.body || '').toLowerCase()

  let kwHits = 0, descHits = 0, bodyHits = 0
  let kwIdf = 0, descIdf = 0, bodyIdf = 0
  const hitTokens = []

  for (const t of taskTokens) {
    const w = idf?.[t] ?? 1
    let hit = false
    if (kwTokens.has(t))   { kwHits++;   kwIdf   += w; hit = true }
    if (descTokens.has(t)) { descHits++; descIdf += w; hit = true }
    const bodyMatches = bodyText.split(t).length - 1
    if (bodyMatches > 0)   {
      const capped = Math.min(3, bodyMatches)
      bodyHits += capped
      bodyIdf  += w * capped * 0.3   // body matches less weighty than headline
      hit = true
    }
    if (hit) hitTokens.push(t)
  }

  // Base score: weighted token hits — keywords 10×, description 5×, body 1× IDF.
  const tokenScore = kwIdf * 10 + descIdf * 5 + bodyIdf

  // Diversity bonus
  const diversity = 1 + Math.max(0, hitTokens.length - 1) * 0.12

  // Orbital boosts (only when classification metadata exists)
  const cls = skill.classification?.class
  const classBoost = (cls && CLASS_BOOST[cls]) ?? 1.0
  const lagrange   = skill.classification?.lagrange_potential ?? 0
  const versatility = 1 + Math.min(0.30, lagrange * 0.5)   // 0–0.3 boost
  const tidalLock  = skill.classification?.tidal_lock ? 1.05 : 1.0

  const finalScore = tokenScore * diversity * classBoost * versatility * tidalLock

  if (tokenScore === 0) return null

  return {
    score:      Number(finalScore.toFixed(3)),
    breakdown: {
      kw_hits:        kwHits,
      desc_hits:      descHits,
      body_hits:      bodyHits,
      kw_idf:         Number(kwIdf.toFixed(2)),
      desc_idf:       Number(descIdf.toFixed(2)),
      body_idf:       Number(bodyIdf.toFixed(2)),
      diversity_mult: Number(diversity.toFixed(2)),
      class:          cls || null,
      class_mult:     Number(classBoost.toFixed(2)),
      lagrange_mult:  Number(versatility.toFixed(2)),
      tidal_lock:     skill.classification?.tidal_lock ?? false,
      tokens:         hitTokens,
    },
  }
}

export function scoreSkills(task, skills, idf) {
  const taskTokens = uniq(tokenize(task))
  if (!taskTokens.length) return []

  const out = []
  for (const skill of skills) {
    const r = scoreOne(skill, taskTokens, idf)
    if (!r) continue
    out.push({
      slug:           skill.slug,
      name:           skill.name,
      description:    skill.description,
      orb_class:      skill.orb_class,
      classification: skill.classification || null,
      route_score:    r.score,
      breakdown:      r.breakdown,
      hits: {
        keywords:    r.breakdown.kw_hits,
        description: r.breakdown.desc_hits,
        body:        r.breakdown.body_hits,
        tokens:      r.breakdown.tokens,
      },
      why: explain(r.breakdown),
    })
  }

  out.sort((a, b) => b.route_score - a.route_score)
  return out
}

function explain(b) {
  const parts = []
  if (b.kw_hits)   parts.push(`${b.kw_hits} keyword`)
  if (b.desc_hits) parts.push(`${b.desc_hits} desc`)
  if (b.body_hits) parts.push(`${b.body_hits} body`)
  let line = parts.join(' · ')
  if (b.class) line += ` · ${b.class}×${b.class_mult}`
  if (b.lagrange_mult > 1.01) line += ` · L×${b.lagrange_mult}`
  if (b.tokens.length) line += ` · "${b.tokens.slice(0, 5).join(', ')}"`
  return line
}

export { corsHeaders, jsonResponse } from './_http.js'
