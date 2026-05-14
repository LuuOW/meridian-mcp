#!/usr/bin/env node
// Calibration simulation for mcp/_lib/orbital.mjs.
//
// Goal: characterise the current classifier's behaviour on a synthetic
// corpus that spans the input space, so we can locate biases before
// proposing fixes (instead of hand-tuning constants on intuition).
//
// Methodology:
//   1. Build a deterministic synthetic generator that emits candidates
//      across crossed axes (body length × keyword count × keyword
//      character × token-density × system-domain × sibling-similarity).
//   2. Run them through orbitalClassify in calibration-set groups
//      (5 candidates per call, mirroring the production N).
//   3. Aggregate:
//        - global class distribution
//        - class-vs-axis cross-tabs (length→class, kws→class, domain→class)
//        - sibling-perturbation stability per candidate (run the same
//          candidate against 6 different sibling sets, check class stays)
//        - "score collapse" rate (how often the second-place class is
//          within 5% of the winner — indicates brittle ties)
//   4. Print a report you can scan to spot disproportionate bias.
//
// Re-runnable; no network, no PRNG (deterministic by seed).

import { orbitalClassify, physicsOf, classOf } from '../../mcp/_lib/orbital.mjs'
import { classOfVariant } from './orbital-variant.mjs'

// Run baseline + variant on the same candidate group and align results.
// Physics signature is shared between the two scorings; only classOf differs.
function compareClassify(candidates, task) {
  const baseline = orbitalClassify(candidates, task)
  return baseline.map(r => {
    const v = classOfVariant(r.classification.physics, !!r.classification.parent)
    return {
      slug:     r.slug,
      physics:  r.classification.physics,
      parent:   r.classification.parent,
      cls_b:    r.classification.class,
      cls_v:    v.cls,
      scores_b: r.classification.class_scores,
      scores_v: v.scores,
    }
  })
}

/* ── deterministic synthetic generator ───────────────────────────────── */

// Lifted from SYSTEM_TERMS so the generator emits tokens the classifier
// actually scores. Kept short — we want predictable affinity, not the
// full term set.
const SYSTEM_VOCAB = {
  forge:  ['api','docker','deploy','network','backend','devops','container','nginx','ssh','build','redis','database','auth','test','kubernetes','observability'],
  signal: ['seo','keyword','content','email','marketing','campaign','analytics','conversion','funnel','audience','brand','traffic','backlink','crm','growth','newsletter'],
  mind:   ['llm','prompt','reasoning','agent','embedding','vector','rag','evaluation','memory','claude','gpt','inference','model','training','dataset','tokenization'],
}
const FILLER = ['the','of','and','to','in','for','with','on','at','as','this','that','these','those','provides','supports','helps','enables','allows','typical','works','runs','uses','accepts','returns','operates','example','reference','behaves','tests','passes','handles','manages']

function det(seed) {
  // Mulberry32 PRNG — deterministic, fast, fine for fixture generation.
  let a = seed | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

// Sample n items from arr without replacement
function sample(arr, n, rng) {
  const pool = [...arr]
  const out = []
  while (out.length < n && pool.length) {
    const i = Math.floor(rng() * pool.length)
    out.push(pool.splice(i, 1)[0])
  }
  return out
}

// Per-candidate UNIQUE token pool — synthetic identifiers that mimic real
// candidate-specific terminology (e.g. "redis-token-bucket" has tokens
// nobody else uses). Without this, all my synthetic candidates pulled from
// the same SYSTEM_VOCAB and collapsed to trojan via inflated dep_ratio.
function uniqueTokenPool(id, n, rng) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(`uniq-${id}-${Math.floor(rng() * 999)}`)
  }
  return out
}

function genCandidate({ id, lenChars, nKws, kwChars, density, systems, uniqueRatio = 0.4, seed }) {
  // systems: array of {sys, weight} — weight controls how many tokens
  // from that system the body draws on.
  // uniqueRatio: fraction of body tokens that are candidate-unique (not
  // in SYSTEM_VOCAB and not shared with siblings). This models the LLM
  // emitting different mechanisms / names per candidate even when they
  // share a task domain.
  const rng = det(seed)
  const totalSysWeight = systems.reduce((s, x) => s + x.weight, 0) || 1
  const kwPool = systems.flatMap(({ sys, weight }) => {
    const n = Math.max(1, Math.round((weight / totalSysWeight) * nKws))
    return sample(SYSTEM_VOCAB[sys], Math.min(n, SYSTEM_VOCAB[sys].length), rng)
  })
  // truncate / pad with candidate-unique terms (not synthetic "extra-N" — we
  // want distinct words per candidate, not a shared "extra-0" token).
  const keywords = kwPool.slice(0, nKws)
  while (keywords.length < nKws) {
    keywords.push(`uniq-kw-${id}-${keywords.length}`)
  }
  if (kwChars > 8) {
    for (let i = 0; i < keywords.length; i++) {
      if (keywords[i].length < kwChars) {
        keywords[i] = `${keywords[i]}-${keywords[i]}`.slice(0, kwChars + 2)
      }
    }
  }

  const sysTokens = systems.flatMap(({ sys, weight }) => {
    const n = Math.max(2, Math.round((weight / totalSysWeight) * 30))
    return sample(SYSTEM_VOCAB[sys], Math.min(n, SYSTEM_VOCAB[sys].length), rng)
  })
  const uniqueTokens = uniqueTokenPool(id, 20, rng)

  let body = ''
  while (body.length < lenChars) {
    const r = rng()
    let token
    if (r < uniqueRatio)            token = uniqueTokens[Math.floor(rng() * uniqueTokens.length)]
    else if (r < uniqueRatio + density) token = sysTokens[Math.floor(rng() * sysTokens.length)] || 'foo'
    else                             token = FILLER[Math.floor(rng() * FILLER.length)]
    body += token + ' '
  }
  body = body.slice(0, lenChars)

  return {
    slug:        `c-${id}`,
    name:        `Candidate ${id}`,
    description: `${keywords[0]} ${keywords[1] || ''} ${keywords[2] || ''}`.trim(),
    keywords,
    body,
  }
}

/* ── archetypes ───────────────────────────────────────────────────────── */

// Each archetype encodes a hypothesis: "this physics shape should map to
// this class." We compare actual outcomes vs the intended class.
const ARCHETYPES = [
  // canonical singletons (sibling-independent intent)
  { name: 'planet/anchor-forge',     lenChars: 2500, nKws: 10, kwChars: 6,  density: 0.45, systems: [{sys:'forge',  weight: 1}], expect: 'planet' },
  { name: 'planet/anchor-mind',      lenChars: 2500, nKws: 10, kwChars: 6,  density: 0.45, systems: [{sys:'mind',   weight: 1}], expect: 'planet' },
  { name: 'planet/anchor-signal',    lenChars: 2500, nKws: 10, kwChars: 6,  density: 0.45, systems: [{sys:'signal', weight: 1}], expect: 'planet' },

  { name: 'asteroid/short-niche-forge',  lenChars: 250,  nKws: 5,  kwChars: 5, density: 0.40, systems: [{sys:'forge',  weight: 1}], expect: 'asteroid' },
  { name: 'asteroid/short-niche-mind',   lenChars: 250,  nKws: 5,  kwChars: 5, density: 0.40, systems: [{sys:'mind',   weight: 1}], expect: 'asteroid' },
  { name: 'asteroid/short-niche-signal', lenChars: 250,  nKws: 5,  kwChars: 5, density: 0.40, systems: [{sys:'signal', weight: 1}], expect: 'asteroid' },

  // duplicates of a canonical → expect moon/trojan when shadowing
  { name: 'moon/satellite-forge',    lenChars: 400,  nKws: 4,  kwChars: 6, density: 0.50, systems: [{sys:'forge',  weight: 1}], expect: 'moon' },
  { name: 'moon/satellite-mind',     lenChars: 400,  nKws: 4,  kwChars: 6, density: 0.50, systems: [{sys:'mind',   weight: 1}], expect: 'moon' },

  // long hyphenated specialist → comet
  { name: 'comet/specialist',        lenChars: 1500, nKws: 8,  kwChars: 14, density: 0.30, systems: [{sys:'mind', weight: 1}], expect: 'comet' },

  // 2-system bridge → irregular
  { name: 'irregular/forge-mind',    lenChars: 1500, nKws: 8,  kwChars: 7,  density: 0.40, systems: [{sys:'forge',weight:1},{sys:'mind',  weight:1}], expect: 'irregular' },
  { name: 'irregular/signal-mind',   lenChars: 1500, nKws: 8,  kwChars: 7,  density: 0.40, systems: [{sys:'signal',weight:1},{sys:'mind', weight:1}], expect: 'irregular' },
  { name: 'irregular/forge-signal',  lenChars: 1500, nKws: 8,  kwChars: 7,  density: 0.40, systems: [{sys:'forge', weight:1},{sys:'signal',weight:1}], expect: 'irregular' },
]

function buildArchetypeCandidate(arch, seed) {
  return genCandidate({ id: arch.name, ...arch, seed })
}

/* ── reports ──────────────────────────────────────────────────────────── */

function classHistogram(rows) {
  const h = { planet: 0, moon: 0, trojan: 0, asteroid: 0, comet: 0, irregular: 0 }
  for (const r of rows) h[r.cls]++
  const total = rows.length
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, { n: v, pct: total ? +(v / total * 100).toFixed(1) : 0 }]))
}

function pearson(xs, ys) {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((s, x) => s + x, 0) / n
  const my = ys.reduce((s, y) => s + y, 0) / n
  let num = 0, dx2 = 0, dy2 = 0
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a*b; dx2 += a*a; dy2 += b*b }
  const denom = Math.sqrt(dx2 * dy2)
  return denom ? num / denom : 0
}

/* ── 1. archetype recall: does each archetype get the expected class? ── */

function runArchetypeRecall() {
  const rows = []
  for (let s = 0; s < 30; s++) {
    for (const arch of ARCHETYPES) {
      const me = buildArchetypeCandidate(arch, s * 1000 + arch.name.length)
      const sibs = sample(ARCHETYPES.filter(a => a !== arch), 4, det(s * 7))
        .map((a, i) => buildArchetypeCandidate(a, s * 1000 + i + 100))
      const cmp = compareClassify([me, ...sibs], 'whatever')
      const meRow = cmp.find(r => r.slug === me.slug)
      rows.push({
        archetype: arch.name,
        expect:    arch.expect,
        cls_b:     meRow.cls_b,
        cls_v:     meRow.cls_v,
        physics:   meRow.physics,
      })
    }
  }
  return rows
}

/* ── 2. length-bias chain: holding content constant, vary body length ── */

function runLengthBias() {
  const rows = []
  const baseRng = det(42)
  for (const arch of ARCHETYPES) {
    for (const lenChars of [200, 400, 800, 1500, 2500, 3000]) {
      const me = buildArchetypeCandidate({ ...arch, lenChars }, 42 + lenChars)
      const sibs = sample(ARCHETYPES.filter(a => a !== arch), 4, baseRng)
        .map((a, i) => buildArchetypeCandidate(a, 42 + i * 11))
      const cmp = compareClassify([me, ...sibs], '')
      const meRow = cmp.find(r => r.slug === me.slug)
      rows.push({
        archetype: arch.name,
        expect:    arch.expect,
        lenChars,
        cls_b:     meRow.cls_b,
        cls_v:     meRow.cls_v,
        mass:      meRow.physics.mass,
      })
    }
  }
  return rows
}

/* ── 3. sibling-perturbation stability: same candidate, different sibs ─ */

function runStability() {
  const rows = []
  for (const arch of ARCHETYPES) {
    const me = buildArchetypeCandidate(arch, 9999)
    const cb = {}, cv = {}
    for (let s = 0; s < 12; s++) {
      const sibs = sample(ARCHETYPES.filter(a => a !== arch), 4, det(s * 31))
        .map((a, i) => buildArchetypeCandidate(a, 9999 + s * 13 + i))
      const cmp = compareClassify([me, ...sibs], '')
      const r = cmp.find(r => r.slug === me.slug)
      cb[r.cls_b] = (cb[r.cls_b] || 0) + 1
      cv[r.cls_v] = (cv[r.cls_v] || 0) + 1
    }
    const modal_b = Object.entries(cb).sort((a, b) => b[1] - a[1])[0]
    const modal_v = Object.entries(cv).sort((a, b) => b[1] - a[1])[0]
    rows.push({
      archetype: arch.name,
      baseline: { modal_class: modal_b[0], modal_pct: +(modal_b[1] / 12 * 100).toFixed(1), distinct: Object.keys(cb).length, counts: cb },
      variant:  { modal_class: modal_v[0], modal_pct: +(modal_v[1] / 12 * 100).toFixed(1), distinct: Object.keys(cv).length, counts: cv },
    })
  }
  return rows
}

/* ── 4. score-collapse rate: how often is 2nd place within 5% of 1st? ── */

function runScoreCollapse(rows) {
  let total = 0, collapsed = 0
  for (const r of rows) {
    if (!r.physics) continue
    const scores = Object.values(r.physics.class_scores ?? {}).filter(Number.isFinite)
    if (scores.length < 2) continue
    scores.sort((a, b) => b - a)
    total++
    if (scores[0] > 0 && (scores[0] - scores[1]) / scores[0] < 0.05) collapsed++
  }
  return { total, collapsed, pct: total ? +(collapsed / total * 100).toFixed(1) : 0 }
}

/* ── main ─────────────────────────────────────────────────────────────── */

function recallReport(rows, label, fieldName) {
  const byArch = {}
  for (const r of rows) {
    const k = r.archetype
    if (!byArch[k]) byArch[k] = { expect: r.expect, counts: {} }
    const cls = r[fieldName]
    byArch[k].counts[cls] = (byArch[k].counts[cls] || 0) + 1
  }
  let hits = 0, total = 0
  for (const [arch, { expect, counts }] of Object.entries(byArch)) {
    const t = Object.values(counts).reduce((s, v) => s + v, 0)
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    total++; if (top[0] === expect) hits++
  }
  return { hits, total, byArch }
}

function histo(rows, field) {
  const h = { planet: 0, moon: 0, trojan: 0, asteroid: 0, comet: 0, irregular: 0 }
  for (const r of rows) h[r[field]] = (h[r[field]] || 0) + 1
  return h
}

function main() {
  console.log('\n=========================================================')
  console.log(' Orbital classifier — calibration simulation')
  console.log(' baseline (current) vs variant (proposed)')
  console.log('=========================================================\n')

  console.log('[1/3] archetype recall@1 (30 trials × ', ARCHETYPES.length, 'archetypes)\n')
  const recall = runArchetypeRecall()
  const rb = recallReport(recall, 'baseline', 'cls_b')
  const rv = recallReport(recall, 'variant',  'cls_v')
  console.log('  archetype                          expect      baseline → variant')
  console.log('  --------------------------------   --------    ----------------------------')
  for (const [arch, { expect, counts: cb }] of Object.entries(rb.byArch)) {
    const cv = rv.byArch[arch].counts
    const topB = Object.entries(cb).sort((a, b) => b[1] - a[1])[0]
    const topV = Object.entries(cv).sort((a, b) => b[1] - a[1])[0]
    const hitB = topB[0] === expect, hitV = topV[0] === expect
    const dB = Object.entries(cb).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c}:${(n/30*100).toFixed(0)}%`).join(' ')
    const dV = Object.entries(cv).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, n]) => `${c}:${(n/30*100).toFixed(0)}%`).join(' ')
    console.log(`  ${arch.padEnd(35)}${expect.padEnd(12)}${hitB?'✓':'✗'} ${dB.padEnd(28)} ${hitV?'✓':'✗'} ${dV}`)
  }
  console.log(`\n  baseline recall@1: ${rb.hits}/${rb.total} = ${(rb.hits/rb.total*100).toFixed(1)}%`)
  console.log(`  variant  recall@1: ${rv.hits}/${rv.total} = ${(rv.hits/rv.total*100).toFixed(1)}%`)

  console.log('\n[2/3] length bias — classes across body-length sweep')
  const lengthRows = runLengthBias()
  console.log('\n  baseline:')
  console.log('  archetype                          200ch  400ch  800ch  1500ch 2500ch 3000ch')
  console.log('  --------------------------------   ----------------------------------------------')
  const byArchB = {}, byArchV = {}
  for (const r of lengthRows) {
    if (!byArchB[r.archetype]) { byArchB[r.archetype] = []; byArchV[r.archetype] = [] }
    byArchB[r.archetype].push(r.cls_b); byArchV[r.archetype].push(r.cls_v)
  }
  for (const [arch, cells] of Object.entries(byArchB)) {
    console.log(`  ${arch.padEnd(35)}${cells.map(c => c.slice(0,6).padEnd(6)).join(' ')}`)
  }
  console.log('\n  variant:')
  console.log('  archetype                          200ch  400ch  800ch  1500ch 2500ch 3000ch')
  console.log('  --------------------------------   ----------------------------------------------')
  for (const [arch, cells] of Object.entries(byArchV)) {
    console.log(`  ${arch.padEnd(35)}${cells.map(c => c.slice(0,6).padEnd(6)).join(' ')}`)
  }
  const lens = lengthRows.map(r => r.lenChars)
  const plB = lengthRows.map(r => r.cls_b === 'planet' ? 1 : 0)
  const plV = lengthRows.map(r => r.cls_v === 'planet' ? 1 : 0)
  console.log(`\n  pearson(length, planet-flag):  baseline ${pearson(lens, plB).toFixed(3)}  →  variant ${pearson(lens, plV).toFixed(3)}`)

  console.log('\n[3/3] sibling perturbation stability\n')
  const stab = runStability()
  console.log('  archetype                          baseline (modal · stable?)   variant')
  console.log('  --------------------------------   --------------------------   --------------------------')
  let stableB = 0, stableV = 0
  for (const r of stab) {
    const sB = r.baseline.distinct === 1, sV = r.variant.distinct === 1
    if (sB) stableB++; if (sV) stableV++
    console.log(`  ${r.archetype.padEnd(35)}${(r.baseline.modal_class+'@'+r.baseline.modal_pct+'%').padEnd(15)} ${sB?'✓':' '} ${r.baseline.distinct}cls   ${(r.variant.modal_class+'@'+r.variant.modal_pct+'%').padEnd(15)} ${sV?'✓':' '} ${r.variant.distinct}cls`)
  }
  console.log(`\n  fully-stable archetypes: baseline ${stableB}/${stab.length}  →  variant ${stableV}/${stab.length}`)

  // Class distribution comparison
  const all = [...recall, ...lengthRows]
  const hB = histo(all, 'cls_b'), hV = histo(all, 'cls_v')
  const N = all.length
  console.log(`\n[dist] class distribution across all ${N} runs (baseline → variant)`)
  for (const c of ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']) {
    const pb = (hB[c] / N * 100).toFixed(1), pv = (hV[c] / N * 100).toFixed(1)
    const bar = '█'.repeat(Math.round(pv / 2))
    console.log(`  ${c.padEnd(10)} ${pb.padStart(5)}% → ${pv.padStart(5)}%  ${bar}`)
  }
}

main()
