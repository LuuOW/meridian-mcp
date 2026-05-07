#!/usr/bin/env node
// Dry-run: Breit-Wigner-shaped reranking with Doppler broadening.
//
// Source: Bell & Glasstone, "Nuclear Reactor Theory", §8.1 (Resonance
// cross sections, eq. 8.1) and §8.1d (Doppler broadening).
//
// The Breit-Wigner formula gives the cross section for a resonance:
//
//     σ(E) ∝  Γ²/4  /  [ (E − E_r)² + Γ²/4 ]                   (8.1)
//
// Lorentzian peaked at E_r with width Γ. In our analogy:
//
//   E       — task ↔ skill match strength (token overlap, [0,1])
//   E_r     — skill's "resonance" point (where it best matches)
//   Γ       — natural width: narrow for asteroid (specialist),
//             broad for planet/comet (generalist)
//   Γ_dop   — Doppler broadening from sibling-set noise (§8.1d):
//             when candidates share boilerplate, the effective
//             width inflates → narrow skills lose their peak.
//             This is exactly the T2 "flooded keywords" sensitivity
//             the stress tests surfaced.
//   σ       — match probability — multiplied with the v2 route_score
//             to produce the reranked score.
//
// Two evaluations:
//   A. Calibration panel (18 skills) — does BW reranking improve the
//      0.50 panel class accuracy / 0.50 recall@1?
//   B. HF labelled data (21 rows) — does BW reranking lift the
//      0.81 [0.62, 0.95] recall@1 CI?
//
// Verdict: ship if either evaluation shows clear lift. Diagnostic
// only otherwise (joining CRTBP + spectral in the receipts).

import { orbitalClassify, physicsOf } from '../mcp/_lib/orbital.mjs'
import { tokenize, uniq }              from '../mcp/_lib/tokenize.mjs'
import { PANEL, TASK, panelForClassify } from './calibration-panel.mjs'

// ── Breit-Wigner reranking ──────────────────────────────────────────
// Takes the v2 orbital ranking (already has route_score and physics
// signatures) and reweights using a Lorentzian on task ↔ skill match.

// Specificity-matching mapping: E_skill = how-narrow-this-skill is,
// E_task = how-narrow-this-task-is. Lorentzian peaks when the skill's
// breadth matches the task's breadth — a specific task resonates with
// a specific skill (asteroid), a broad task with a broad skill (comet
// or planet). Going off-resonance falls off ∝ 1/(δE² + Γ²/4).
function bwScore(skill, task, sibTokens, taskSpecificity) {
  const physics = physicsOf(skill, sibTokens)

  // E_skill ∈ [0, 1] — high = narrow / specialist (1 - cross_domain
  // captures "single-domain anchored", high fragmentation also pulls
  // narrow). Map: asteroid → 0.85, planet → 0.55, comet → 0.20.
  const E_skill = Math.max(0, Math.min(1,
    0.55
    - 0.35 * physics.cross_domain    // broad skills shift left
    + 0.15 * physics.fragmentation   // fragmented narrow shift right
    - 0.10 * physics.scope           // wide-scope shifts left
  ))

  // Natural width Γ — broader for cross-domain skills. The Lorentzian
  // is forgiving for them but punishing for narrow specialists.
  const Γ_nat = 0.10 + 0.45 * physics.cross_domain    // [0.10, 0.55]

  // Doppler broadening Γ_dop — sibling-set noise (§8.1d). High mean
  // sibling overlap (boilerplate-flooded candidate sets) inflates Γ.
  // This is the explicit fix for T2 "flooded keywords" sensitivity.
  let sumOverlap = 0, nSib = 0
  const skillToks = new Set([
    ...tokenize(skill.description || ''),
    ...tokenize(skill.body || ''),
    ...(skill.keywords || []).flatMap(k => tokenize(String(k))),
  ])
  for (const sib of sibTokens) {
    if (sib.skill === skill) continue
    const sToks = new Set(sib.toks)
    let i = 0
    for (const t of skillToks) if (sToks.has(t)) i++
    const u = new Set([...skillToks, ...sToks]).size
    sumOverlap += u ? i / u : 0
    nSib++
  }
  const meanSibOverlap = nSib ? sumOverlap / nSib : 0
  const Γ_dop = Math.sqrt(meanSibOverlap) * 0.30

  // Effective width — quadrature sum (B&G §8.1d)
  const Γ = Math.sqrt(Γ_nat * Γ_nat + Γ_dop * Γ_dop)

  // Breit-Wigner cross section, peak normalised to 1
  const δ     = taskSpecificity - E_skill
  const denom = δ * δ + (Γ * Γ) / 4
  const σ     = (Γ * Γ / 4) / denom

  return { σ, E_skill, E_task: taskSpecificity, δ, Γ, Γ_nat, Γ_dop }
}

// Task specificity ∈ [0, 1]: higher = narrower / more specialist task.
// Heuristic — short tasks with rare technical terms score high; long
// general tasks score low. Independent of the skill set so it's a true
// task property, not a relative measure.
function specificityOf(task) {
  const toks = uniq(tokenize(task))
  const nTok = toks.length
  // Concentration: how many tokens look "specialist" (4+ chars, not
  // among the most common english stopwords + common verbs).
  const COMMON = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'have', 'will', 'you', 'are', 'was', 'one', 'how', 'use', 'using', 'data', 'tool', 'task', 'help', 'find', 'show', 'make', 'need'])
  const specialists = toks.filter(t => t.length >= 5 && !COMMON.has(t)).length
  const concentration = nTok ? specialists / nTok : 0
  // Length factor: shorter task = more specific (less hedging)
  const lenFactor = 1 / (1 + Math.exp((nTok - 12) / 4))   // sigmoid centred at 12 tokens
  return Math.max(0, Math.min(1, 0.3 + 0.5 * concentration + 0.2 * lenFactor))
}

function bwRerank(skills, task) {
  const ranked = orbitalClassify(skills, task)

  const sibTokens = ranked.map(r => ({
    skill: r,
    toks: uniq(tokenize(`${r.description || ''} ${r.body || ''} ${(r.keywords || []).join(' ')}`)),
  }))

  const taskSpec = specificityOf(task)
  const taskToks = new Set(tokenize(task))

  // BW as a STANDALONE scorer — bypass v2's [0, 500] dynamic range
  // (which would otherwise drown out the [0, 1] Lorentzian). Two
  // factors: token-overlap relevance × Lorentzian specificity-match.
  const reranked = ranked.map(r => {
    const skillToks = new Set([
      ...tokenize(r.description || ''),
      ...tokenize(r.body || ''),
      ...(r.keywords || []).flatMap(k => tokenize(String(k))),
    ])
    let inter = 0
    for (const t of taskToks) if (skillToks.has(t)) inter++
    const overlap = taskToks.size ? inter / taskToks.size : 0

    const bw = bwScore(r, task, sibTokens, taskSpec)

    // Combined score: relevance × resonance. Both ∈ [0, 1].
    const new_score = (overlap + 0.05) * (bw.σ + 0.05)
    return { ...r, bw, original_score: r.route_score, route_score: new_score, overlap }
  }).sort((a, b) => b.route_score - a.route_score)

  return reranked
}

// ── Evaluation A — calibration panel ────────────────────────────────
function evalPanel() {
  const panel = panelForClassify()
  const v2 = orbitalClassify(panel, TASK)
  const bw = bwRerank(panel, TASK)

  let v2_class_hits = 0, bw_class_hits = 0
  for (const r of v2) {
    const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
    if (expected && r.classification.class === expected) v2_class_hits++
  }
  for (const r of bw) {
    const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
    if (expected && r.classification.class === expected) bw_class_hits++
  }

  const relevantSlugs = new Set(PANEL.filter(p => p.__relevant).map(p => p.slug))
  const v2_top1 = new Set(v2.slice(0, 1).map(r => r.slug))
  const bw_top1 = new Set(bw.slice(0, 1).map(r => r.slug))
  const v2_recall1 = [...relevantSlugs].filter(s => v2_top1.has(s)).length / Math.max(1, relevantSlugs.size)
  const bw_recall1 = [...relevantSlugs].filter(s => bw_top1.has(s)).length / Math.max(1, relevantSlugs.size)

  return {
    v2: { class_acc: v2_class_hits / v2.length, recall_at_1: v2_recall1 },
    bw: { class_acc: bw_class_hits / bw.length, recall_at_1: bw_recall1 },
    top_change: v2[0].slug !== bw[0].slug,
    v2_top: v2[0].slug,
    bw_top: bw[0].slug,
  }
}

// ── Evaluation B — HF labelled data ─────────────────────────────────
async function evalLabelled() {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent('shawhin/tool-use-finetuning')}&config=default&split=test&offset=0&length=60`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HF datasets-server ${res.status}`)
  const body = await res.json()
  const rows = body.rows.map(r => r.row)

  function extractTools(traceJson) {
    const trace = typeof traceJson === 'string' ? JSON.parse(traceJson) : traceJson
    const sys = trace?.[0]?.content || ''
    const m = sys.match(/<tools>\s*([\s\S]*?)\s*<\/tools>/)
    if (!m) return []
    try { return JSON.parse(m[1]) } catch { return [] }
  }
  function toolToSkill(tool) {
    const args = tool.input_args || {}
    const argNames = Object.keys(args)
    const descTokens = uniq(tokenize(tool.description || '')).slice(0, 8)
    const keywords = uniq([...argNames, ...descTokens]).slice(0, 10)
    const argLines = argNames.length ? argNames.map(a => `- \`${a}\`: ${args[a]}`).join('\n') : '- (no args)'
    const bodyMd = `## Use It For\n- ${tool.description || tool.tool_name}\n\n## Args\n${argLines}\n\n## Output\nReturns the result of \`${tool.tool_name}\`.`
    return { slug: tool.tool_name, name: tool.tool_name, description: tool.description || '', keywords, body: bodyMd }
  }

  const evalRows = []
  for (const r of rows) {
    if (!r.tool_needed || !r.tool_name) continue
    const tools = extractTools(r.trace)
    if (tools.length < 2) continue
    if (!tools.some(t => t.tool_name === r.tool_name)) continue
    evalRows.push({ query: r.query, label: r.tool_name, skills: tools.map(toolToSkill), type: r.query_type })
  }

  const hits = { v2_h1: [], v2_h5: [], bw_h1: [], bw_h5: [] }
  let v2_h1 = 0, v2_h5 = 0, bw_h1 = 0, bw_h5 = 0
  const swaps = []
  for (const ex of evalRows) {
    const v2 = orbitalClassify(ex.skills, ex.query)
    const bw = bwRerank(ex.skills, ex.query)
    const v2Rank = v2.findIndex(r => r.slug === ex.label)
    const bwRank = bw.findIndex(r => r.slug === ex.label)
    if (v2Rank === 0)                      v2_h1++
    if (v2Rank >= 0 && v2Rank < 5)         v2_h5++
    if (bwRank === 0)                      bw_h1++
    if (bwRank >= 0 && bwRank < 5)         bw_h5++
    hits.v2_h1.push(v2Rank === 0 ? 1 : 0)
    hits.v2_h5.push(v2Rank >= 0 && v2Rank < 5 ? 1 : 0)
    hits.bw_h1.push(bwRank === 0 ? 1 : 0)
    hits.bw_h5.push(bwRank >= 0 && bwRank < 5 ? 1 : 0)
    if (v2Rank !== bwRank) {
      swaps.push({ query: ex.query.slice(0, 60), label: ex.label, v2_top: v2[0].slug, v2_rank: v2Rank, bw_top: bw[0].slug, bw_rank: bwRank })
    }
  }

  function bootstrapCI(arr, B = 10_000) {
    const n = arr.length
    if (!n) return { mean: 0, lo: 0, hi: 0 }
    const samples = new Float64Array(B)
    for (let b = 0; b < B; b++) {
      let s = 0
      for (let i = 0; i < n; i++) s += arr[(Math.random() * n) | 0]
      samples[b] = s / n
    }
    samples.sort()
    return {
      mean: arr.reduce((s, v) => s + v, 0) / n,
      lo: samples[Math.floor(B * 0.025)],
      hi: samples[Math.floor(B * 0.975) - 1],
    }
  }

  const N = evalRows.length
  return {
    n: N,
    v2: { recall_at_1: v2_h1 / N, recall_at_5: v2_h5 / N, ci_at_1: bootstrapCI(hits.v2_h1), ci_at_5: bootstrapCI(hits.v2_h5) },
    bw: { recall_at_1: bw_h1 / N, recall_at_5: bw_h5 / N, ci_at_1: bootstrapCI(hits.bw_h1), ci_at_5: bootstrapCI(hits.bw_h5) },
    swaps: swaps.slice(0, 8),
    n_swaps: swaps.length,
  }
}

// ── Run ─────────────────────────────────────────────────────────────
console.log('\nBREIT-WIGNER RERANK — dry run (Bell & Glasstone §8.1 + Doppler 8.1d)')
console.log('====================================================================')

const A = evalPanel()
console.log('\nA. Calibration panel (18 synthetic skills)')
console.log(`     class_accuracy   v2 ${A.v2.class_acc.toFixed(3)}    bw ${A.bw.class_acc.toFixed(3)}    Δ ${(A.bw.class_acc - A.v2.class_acc).toFixed(3)}`)
console.log(`     recall@1         v2 ${A.v2.recall_at_1.toFixed(3)}    bw ${A.bw.recall_at_1.toFixed(3)}    Δ ${(A.bw.recall_at_1 - A.v2.recall_at_1).toFixed(3)}`)
console.log(`     top result       v2 ${A.v2_top}   →   bw ${A.bw_top}   ${A.top_change ? '(swapped)' : '(unchanged)'}`)

console.log('\nB. Labelled data (HF shawhin/tool-use-finetuning, n=21)')
const B = await evalLabelled()
const fmt = c => `${c.mean.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]`
console.log(`     recall@1   v2  ${fmt(B.v2.ci_at_1)}`)
console.log(`     recall@1   bw  ${fmt(B.bw.ci_at_1)}    Δ ${(B.bw.ci_at_1.mean - B.v2.ci_at_1.mean).toFixed(3)}`)
console.log(`     recall@5   v2  ${fmt(B.v2.ci_at_5)}`)
console.log(`     recall@5   bw  ${fmt(B.bw.ci_at_5)}    Δ ${(B.bw.ci_at_5.mean - B.v2.ci_at_5.mean).toFixed(3)}`)
console.log(`     swaps (v2 vs bw rank differs):  ${B.n_swaps}/${B.n}`)
for (const s of B.swaps) console.log(`       ${s.query}  label=${s.label}  v2=${s.v2_top}(r${s.v2_rank})  bw=${s.bw_top}(r${s.bw_rank})`)

// ── Verdict ─────────────────────────────────────────────────────────
console.log('\nVERDICT')
const lift = B.bw.ci_at_1.mean - B.v2.ci_at_1.mean
const clear_win = B.bw.ci_at_1.lo > B.v2.ci_at_1.hi
const panel_win = A.bw.class_acc > A.v2.class_acc + 0.05
if (clear_win) {
  console.log(`  ✓ BW unambiguously beats v2 on labelled data (CI separation). Ship as v3.`)
  process.exit(0)
} else if (lift > 0.04 || panel_win) {
  console.log(`  ◐ BW shows lift on point estimate (Δr@1 = ${lift.toFixed(3)}, panel Δ = ${(A.bw.class_acc - A.v2.class_acc).toFixed(3)}).`)
  console.log(`     CI overlaps with v2 — suggestive but not conclusive at n=${B.n}.`)
  process.exit(0)
} else {
  console.log(`  ✗ BW does not improve over v2 (Δr@1 = ${lift.toFixed(3)}). Diagnostic only.`)
  process.exit(0)
}
