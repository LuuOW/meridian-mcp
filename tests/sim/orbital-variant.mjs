// Proposed calibration variant — same physics signature, retuned class
// scoring. Goal: lift moon/comet/irregular out of structural dead zones
// without regressing planet/asteroid on canonical anchors.
//
// Changes vs the live classOf (mcp/_lib/orbital.mjs:179):
//
//   1. planet: now penalised by cross_domain — anchors should be
//      domain-focused, not bridges. Multiplier (1 - 0.5·cross_domain).
//
//   2. moon: independence threshold lifted 0.5 → 0.85, parent multiplier
//      doubled (1 → 2 with parent, 0.4 → 0.3 without). Same mass-tax to
//      keep heavy anchors out. Lets dep_ratio=0.4 candidates with a
//      parent fire moon (the docker-compose case the baseline missed).
//
//   3. comet: drag-only signal, no longer gated on cross_domain. Specialist
//      = high drag (hyphenated keywords) + low dep_ratio + low mass.
//      Picks up specialists who happen to be single-system.
//
//   4. irregular: cross_domain · (fragmentation + 0.5). Broader band so
//      multi-system bridges fire even at moderate fragmentation.
//
// The argmax shape is unchanged. The class set is unchanged.

export function classOfVariant(p, hasParentInSet) {
  // Moon: token-Jaccard parent gate misfires when sibling overlap rides on
  // keywords instead of body tokens (the docker / docker-compose case in
  // the canonical fixtures). Lean on dep_ratio directly — it's the smooth
  // version of "has a parent-like sibling" since it's max(token, keyword)
  // Jaccard. Multiplier `(0.3 + 1.7·dep_ratio)` lifts moon from 0.3× at
  // dep_ratio=0 to 2.0× at dep_ratio=1.0, smoothly.
  const parent_pull = 0.3 + 1.7 * p.dep_ratio

  const planet_score   = Math.min(p.mass, p.scope, p.independence) ** 1.5
                         * (1 - 0.5 * p.cross_domain)
  const moon_score     = Math.max(0, 0.85 - p.independence) * 2
                         * parent_pull
                         * (1 - 0.5 * p.mass)
  const trojan_score   = p.dep_ratio * (hasParentInSet ? 1 : 0.5) * (1 - p.fragmentation)
  const asteroid_score = Math.max(0, 0.55 - p.mass) * 2.5 * p.scope * p.independence
  const comet_score    = p.drag * (1 - p.dep_ratio) * (1 - 0.4 * p.mass) * 1.3
  const irregular_score= p.cross_domain * (p.fragmentation + 0.5)

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
