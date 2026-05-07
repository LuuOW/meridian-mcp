#!/usr/bin/env node
// Stress tests for the orbital classifier — probes failure modes the
// other receipts don't cover. Designed to bullet-proof the router.
//
// Sub-tests
// ─────────
// T1  body-length perturbation     — scale body 0.5× / 2× / 4×; class flips?
// T2  keyword-count perturbation   — half / double keyword count; class flips?
// T3  sibling-set sensitivity      — classify alone vs in panel; class flips?
// T4  adversarial inputs           — empty / 1-word / 5000-char / 30-kws /
//                                    code-only / non-English / no-keywords;
//                                    no-crash + sane class
// T5  class confusion matrix       — actual vs expected on the panel
// T6  candidate-set jitter         — drop one random candidate; top-3 Jaccard
//
// Output: human report by default, or `--json` for CI consumption.
// Exit 1 if any hard regression bound is exceeded.

import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
import { PANEL, TASK, panelForClassify } from './calibration-panel.mjs'

const JSON_MODE = process.argv.includes('--json')
const log = JSON_MODE ? () => {} : (...a) => console.log(...a)

const CLASSES = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']
const round = x => Math.round(x * 1000) / 1000

function classify(skills, task = TASK) {
  return orbitalClassify(skills, task)
}

function classOfSlug(ranked, slug) {
  return ranked.find(r => r.slug === slug)?.classification?.class || null
}

// ── T1: body-length perturbation ────────────────────────────────────
function testLengthPerturbation() {
  const factors = [0.5, 2, 4]
  const baseline = classify(panelForClassify())
  const baseClass = Object.fromEntries(baseline.map(r => [r.slug, r.classification.class]))
  const flips = { '0.5x': 0, '2x': 0, '4x': 0 }
  const detail = []

  for (const f of factors) {
    const perturbed = panelForClassify().map(s => {
      let body = s.body || ''
      if (f < 1) body = body.slice(0, Math.max(50, Math.floor(body.length * f)))
      else       body = (body + '\n').repeat(Math.max(1, Math.round(f))).slice(0, Math.floor(body.length * f))
      return { ...s, body }
    })
    const ranked = classify(perturbed)
    for (const r of ranked) {
      if (r.classification.class !== baseClass[r.slug]) {
        flips[`${f}x`]++
        if (detail.length < 30) detail.push({ slug: r.slug, factor: f, was: baseClass[r.slug], now: r.classification.class })
      }
    }
  }
  return { flips, total: PANEL.length * factors.length, detail }
}

// ── T2: keyword-count perturbation ──────────────────────────────────
function testKeywordPerturbation() {
  const baseline = classify(panelForClassify())
  const baseClass = Object.fromEntries(baseline.map(r => [r.slug, r.classification.class]))
  const cases = {
    half:    s => ({ ...s, keywords: (s.keywords || []).slice(0, Math.max(1, Math.floor((s.keywords || []).length / 2))) }),
    double:  s => ({ ...s, keywords: [...(s.keywords || []), ...(s.keywords || []).map(k => k + '-2')] }),
    none:    s => ({ ...s, keywords: [] }),
    flooded: s => ({ ...s, keywords: [...(s.keywords || []), ...Array.from({ length: 22 }, (_, i) => `noise-${i}`)] }),
  }
  const flips = {}
  const detail = []
  for (const [name, fn] of Object.entries(cases)) {
    flips[name] = 0
    const perturbed = panelForClassify().map(fn)
    const ranked = classify(perturbed)
    for (const r of ranked) {
      if (r.classification.class !== baseClass[r.slug]) {
        flips[name]++
        if (detail.length < 30) detail.push({ slug: r.slug, case: name, was: baseClass[r.slug], now: r.classification.class })
      }
    }
  }
  return { flips, total_per_case: PANEL.length, detail }
}

// ── T3: sibling-set sensitivity ─────────────────────────────────────
// Classify each skill in isolation (siblings = []) vs in the full
// panel. Catches over-reliance on dep_ratio coupling.
function testSiblingSensitivity() {
  const baseline = classify(panelForClassify())
  const baseClass = Object.fromEntries(baseline.map(r => [r.slug, r.classification.class]))

  let flips = 0
  const detail = []
  for (const s of panelForClassify()) {
    const alone = classify([s])
    const cls = alone[0]?.classification?.class
    if (cls !== baseClass[s.slug]) {
      flips++
      if (detail.length < 30) detail.push({ slug: s.slug, in_panel: baseClass[s.slug], alone: cls })
    }
  }
  return { flips, total: PANEL.length, detail }
}

// ── T4: adversarial inputs ──────────────────────────────────────────
// We don't expect any specific class — we expect:
//   1. orbitalClassify never throws
//   2. it always returns a valid class
//   3. score is finite
function testAdversarialInputs() {
  const adversarial = [
    { slug: 'empty-body',        description: '', keywords: [], body: '' },
    { slug: 'one-word-body',     description: 'x', keywords: ['x'], body: 'x' },
    { slug: 'huge-body',         description: 'big', keywords: ['big'], body: 'lorem '.repeat(900) },
    { slug: 'thirty-keywords',   description: 'kw bomb', keywords: Array.from({ length: 30 }, (_, i) => `kw${i}`), body: 'short body' },
    { slug: 'code-only-body',    description: 'parser', keywords: ['parse'], body: '```js\nconst x = 1\nfor (let i = 0; i < 100; i++) console.log(i)\n```' },
    { slug: 'non-english-body',  description: 'recherche', keywords: ['recherche', 'analyse'], body: 'Ce skill effectue une analyse syntaxique des résultats. Il sert à la recherche d\'informations dans les documents.' },
    { slug: 'all-caps-body',     description: 'YELLING', keywords: ['LOUD'], body: 'THIS IS A SKILL DESCRIPTION THAT YELLS LOUDLY ABOUT ITS PURPOSE WHICH IS TO PROCESS DATA IN A LOUD MANNER.' },
    { slug: 'symbols-noise',     description: '!@#$', keywords: ['!@#'], body: '$$$ ## !!! @@@ %%% ^^^ &&& *** ((( ))) +++ === ~~~ ::: ;;; ??? ,,, ...' },
  ]
  const ranked = classify(adversarial, 'parse data and return results')
  const errors = []
  const summary = ranked.map(r => {
    const cls   = r.classification?.class
    const score = r.route_score
    if (!CLASSES.includes(cls)) errors.push(`${r.slug}: invalid class ${cls}`)
    if (!Number.isFinite(score)) errors.push(`${r.slug}: non-finite score`)
    return { slug: r.slug, class: cls, score: round(score) }
  })
  return { errors, summary, n: adversarial.length }
}

// ── T5: class confusion matrix ──────────────────────────────────────
function testConfusionMatrix() {
  const baseline = classify(panelForClassify())
  const matrix = {}
  for (const expected of CLASSES) {
    matrix[expected] = {}
    for (const actual of CLASSES) matrix[expected][actual] = 0
  }
  for (const r of baseline) {
    const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
    const actual = r.classification.class
    if (expected && CLASSES.includes(expected)) matrix[expected][actual]++
  }
  let correct = 0, total = 0
  for (const cls of CLASSES) {
    correct += matrix[cls][cls]
    for (const c2 of CLASSES) total += matrix[cls][c2]
  }
  return { matrix, accuracy: round(correct / Math.max(1, total)) }
}

// ── T6: candidate-set jitter ────────────────────────────────────────
// Drop one random candidate at a time and check top-3 Jaccard against
// the full-panel ranking. Measures how stable the top-K is under tiny
// candidate-set changes (a real-world failure mode: an LLM dropping
// one suggestion shouldn't reshuffle the whole top).
function testCandidateJitter(seedRuns = 18) {
  const baseline = classify(panelForClassify())
  const baseTop3 = new Set(baseline.slice(0, 3).map(r => r.slug))
  let totalJaccard = 0
  let kept = 0
  const drops = []
  for (let i = 0; i < seedRuns; i++) {
    const dropIdx = i % PANEL.length
    const dropped = panelForClassify().filter((_, j) => j !== dropIdx)
    const ranked = classify(dropped)
    const newTop3 = new Set(ranked.slice(0, 3).map(r => r.slug))
    // ignore the dropped slug for Jaccard (it can't be in the new set)
    const dropSlug = PANEL[dropIdx].slug
    const baseAdj = new Set([...baseTop3].filter(s => s !== dropSlug))
    if (!baseAdj.size) continue
    const inter = [...baseAdj].filter(s => newTop3.has(s)).length
    const union = new Set([...baseAdj, ...newTop3]).size
    const j = union ? inter / union : 1
    totalJaccard += j
    kept++
    if (j < 1) drops.push({ dropped: dropSlug, baseline: [...baseAdj], new_top: [...newTop3], jaccard: round(j) })
  }
  return { mean_jaccard: round(totalJaccard / Math.max(1, kept)), n_runs: kept, instability_examples: drops.slice(0, 6) }
}

// ── Run all ─────────────────────────────────────────────────────────
const t1 = testLengthPerturbation()
const t2 = testKeywordPerturbation()
const t3 = testSiblingSensitivity()
const t4 = testAdversarialInputs()
const t5 = testConfusionMatrix()
const t6 = testCandidateJitter()

const t1_rate = round((t1.flips['0.5x'] + t1.flips['2x'] + t1.flips['4x']) / t1.total)
const t2_rate = round((t2.flips.half + t2.flips.double + t2.flips.none + t2.flips.flooded) / (t2.total_per_case * 4))
const t3_rate = round(t3.flips / t3.total)

// Regression bounds — set above currently-observed flip rates so the
// script catches future drift, not current state. Body-length and
// keyword-count flips ARE expected (those are real signals); we only
// alarm on much-worse-than-now. Floor metrics (T5/T6) cap downside.
const fails = []
if (t1_rate > 0.70)               fails.push(`T1 length-perturb flip rate ${t1_rate} > 0.70 — classifier far more length-sensitive than baseline`)
if (t2_rate > 0.80)               fails.push(`T2 keyword-perturb flip rate ${t2_rate} > 0.80 — classifier far more keyword-sensitive than baseline`)
if (t3_rate > 0.30)               fails.push(`T3 sibling-isolation flip rate ${t3_rate} > 0.30 — classifier over-relies on sibling set`)
if (t4.errors.length)             fails.push(`T4 adversarial inputs caused ${t4.errors.length} crash/invalid outputs`)
if (t5.accuracy < 0.40)           fails.push(`T5 class accuracy ${t5.accuracy} < 0.40 — regressed below shipped baseline`)
if (t6.mean_jaccard < 0.70)       fails.push(`T6 top-3 Jaccard ${t6.mean_jaccard} < 0.70 — top-K unstable under candidate jitter`)

// ── Output ──────────────────────────────────────────────────────────
if (JSON_MODE) {
  process.stdout.write(JSON.stringify({
    t1_length_perturbation:  { ...t1, flip_rate: t1_rate },
    t2_keyword_perturbation: { ...t2, flip_rate: t2_rate },
    t3_sibling_sensitivity:  { ...t3, flip_rate: t3_rate },
    t4_adversarial:          t4,
    t5_confusion:            t5,
    t6_candidate_jitter:     t6,
    fails,
    generated_at: new Date().toISOString(),
  }, null, 2) + '\n')
  process.exit(fails.length ? 1 : 0)
}

log('\nSTRESS TESTS — orbital classifier')
log('================================')

log(`\nT1  body-length perturbation        flip rate ${t1_rate}  (${t1.flips['0.5x']}/${PANEL.length} @0.5×, ${t1.flips['2x']}/${PANEL.length} @2×, ${t1.flips['4x']}/${PANEL.length} @4×)`)
if (t1.detail.length) {
  for (const d of t1.detail.slice(0, 6)) log(`     ${d.slug.padEnd(34)} ${d.factor}×  ${d.was} → ${d.now}`)
}

log(`\nT2  keyword-count perturbation      flip rate ${t2_rate}  (half ${t2.flips.half}, double ${t2.flips.double}, none ${t2.flips.none}, flooded ${t2.flips.flooded} per ${t2.total_per_case})`)
if (t2.detail.length) {
  for (const d of t2.detail.slice(0, 6)) log(`     ${d.slug.padEnd(34)} ${d.case.padEnd(8)} ${d.was} → ${d.now}`)
}

log(`\nT3  sibling-set sensitivity         flip rate ${t3_rate}  (${t3.flips}/${t3.total} reclassify when isolated)`)
if (t3.detail.length) {
  for (const d of t3.detail.slice(0, 6)) log(`     ${d.slug.padEnd(34)} panel=${d.in_panel.padEnd(10)} alone=${d.alone}`)
}

log(`\nT4  adversarial inputs              ${t4.errors.length} crash/invalid    ${t4.n} fixtures`)
for (const r of t4.summary) log(`     ${r.slug.padEnd(20)} class=${(r.class || 'NULL').padEnd(10)} score=${r.score}`)
for (const e of t4.errors) log(`     ✗ ${e}`)

log(`\nT5  class confusion matrix          accuracy ${t5.accuracy}  (rows=expected, cols=actual)`)
const colHdr = ['         '].concat(CLASSES.map(c => c.slice(0, 4).padStart(5))).join('')
log(colHdr)
for (const expected of CLASSES) {
  const row = [expected.padStart(9)].concat(CLASSES.map(actual => String(t5.matrix[expected][actual]).padStart(5))).join('')
  log(row)
}

log(`\nT6  candidate-set jitter            mean top-3 Jaccard ${t6.mean_jaccard}  (${t6.n_runs} drop-one runs)`)
for (const j of t6.instability_examples) {
  log(`     drop ${j.dropped.padEnd(34)} J=${j.jaccard}  base=${j.baseline.join(',')}  new=${j.new_top.join(',')}`)
}

log('\nVERDICT')
if (fails.length === 0) {
  log('  ✓ all stress tests passed within bounds')
} else {
  for (const f of fails) log(`  ✗ ${f}`)
}

process.exit(fails.length ? 1 : 0)
