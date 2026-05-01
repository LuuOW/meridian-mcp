// Lexical scorer used by /api/route. NOT the full orbital algorithm —
// that one needs Python and embeddings, neither of which run in a Workers
// isolate. This is a "good enough for the demo" approximation: token
// matches against keywords (10x), description (5x), and body (1x, capped).

const STOP = new Set([
  'the','and','for','with','that','this','from','have','your','about',
  'into','what','when','where','which','their','there','these','those',
  'will','would','should','could','been','being','need','want','get',
  'set','use','using','make','made','like','also','some','any','all',
  'one','two','out','off','its','it\'s','you','you\'re','our'
])

function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t))
}

function uniq(arr) { return [...new Set(arr)] }

export function scoreSkills(task, skills) {
  const taskTokens = uniq(tokenize(task))
  if (!taskTokens.length) return []

  const results = []
  for (const skill of skills) {
    const descTokens = new Set(tokenize(skill.description))
    const kwTokens   = new Set((skill.keywords || []).flatMap(k => tokenize(k)))
    const bodyText   = (skill.body || '').toLowerCase()

    let kwHits = 0, descHits = 0, bodyHits = 0
    const hitTokens = []

    for (const t of taskTokens) {
      let hit = false
      if (kwTokens.has(t))   { kwHits++;   hit = true }
      if (descTokens.has(t)) { descHits++; hit = true }
      const bodyMatches = bodyText.split(t).length - 1
      if (bodyMatches > 0)   { bodyHits += Math.min(3, bodyMatches); hit = true }
      if (hit) hitTokens.push(t)
    }

    const baseScore = kwHits * 10 + descHits * 5 + bodyHits
    if (baseScore === 0) continue

    // Diversity bonus: more distinct tokens hitting = stronger match
    const diversityMult = 1 + (hitTokens.length - 1) * 0.15

    const score = baseScore * diversityMult

    results.push({
      slug:        skill.slug,
      name:        skill.name,
      description: skill.description,
      orb_class:   skill.orb_class,
      route_score: Number(score.toFixed(3)),
      hits: {
        keywords:    kwHits,
        description: descHits,
        body:        bodyHits,
        tokens:      hitTokens,
      },
      why: explain(hitTokens, kwHits, descHits, bodyHits),
    })
  }

  results.sort((a, b) => b.route_score - a.route_score)
  return results
}

function explain(tokens, kw, desc, body) {
  const parts = []
  if (kw)   parts.push(`${kw} keyword match${kw === 1 ? '' : 'es'}`)
  if (desc) parts.push(`${desc} description hit${desc === 1 ? '' : 's'}`)
  if (body) parts.push(`${body} body mention${body === 1 ? '' : 's'}`)
  if (!tokens.length) return 'no match'
  return `${parts.join(', ')} on: ${tokens.slice(0, 6).join(', ')}`
}

export function corsHeaders(origin = '*') {
  return {
    'access-control-allow-origin':  origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age':       '86400',
  }
}

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status:  init.status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...(init.headers || {}) },
  })
}
