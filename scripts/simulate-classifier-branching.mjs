#!/usr/bin/env node
// Dry-run: branching-ratio class probabilities (Bell & Glasstone §8.2b
// "Decay channels and level width distribution"; Wong §8-2 Compound
// Nucleus Formation).
//
// In nuclear physics, a compound nucleus formed from a (task → nucleus)
// reaction decays through multiple channels with relative widths Γ_c.
// The branching ratio P(channel c) = Γ_c / Γ_total is a probability,
// not a hard label. Same logic applies here: a skill doesn't BELONG
// to one class — it has a probability distribution over classes.
//
// The existing classifier already computes raw per-class scores
// (mcp/_lib/orbital.mjs:156-164). It then takes argmax to assign a
// hard class. This experiment turns those scores into a calibrated
// distribution via temperature-scaled softmax and validates with:
//   • Brier score on the synthetic panel (with ground-truth labels)
//   • Confusion-matrix reduction: how often is the *correct* class
//     in the top-2 of the distribution? (handles "asteroid attractor")
//   • Stability: does the distribution shift smoothly under stress
//     (matches T1/T2 from stress-test-classifier.mjs)
//
// If well-calibrated, ship as additive `class_distribution` field
// in the production classification output. Backwards compatible.

import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
import { PANEL, TASK, panelForClassify } from './calibration-panel.mjs'

const CLASSES = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']

// Temperature-scaled softmax over the raw class_scores. Higher T →
// flatter distribution; T = 1 is plain softmax. We tune T to minimise
// Brier on the panel (cross-validation in spirit, though we have only
// one panel so we just sweep).
function softmax(scoresObj, T = 1.0) {
  const xs = CLASSES.map(c => (scoresObj[c] || 0) / T)
  const max = Math.max(...xs)
  const exps = xs.map(x => Math.exp(x - max))
  const Z = exps.reduce((s, v) => s + v, 0) || 1
  const probs = {}
  for (let i = 0; i < CLASSES.length; i++) probs[CLASSES[i]] = exps[i] / Z
  return probs
}

function brierScore(predictions, labels) {
  // Multiclass Brier: (1/N) Σᵢ Σ_c (p̂_ic − y_ic)²  ∈ [0, 2]
  let total = 0
  for (let i = 0; i < predictions.length; i++) {
    for (const c of CLASSES) {
      const y = (labels[i] === c) ? 1 : 0
      const p = predictions[i][c] || 0
      total += (p - y) ** 2
    }
  }
  return total / predictions.length
}

function topK(probs, k) {
  return Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, k).map(([c]) => c)
}

// ── Run on calibration panel ────────────────────────────────────────
const ranked = orbitalClassify(panelForClassify(), TASK)
const labels = ranked.map(r => PANEL.find(p => p.slug === r.slug)?.__expectedClass)

// Sweep temperature
const Ts = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0]
const sweep = []
for (const T of Ts) {
  const dists = ranked.map(r => softmax(r.classification.class_scores, T))
  const brier = brierScore(dists, labels)
  // Top-1 = argmax of softmax (should match hard class for any T)
  const top1Acc = dists.filter((d, i) => topK(d, 1)[0] === labels[i]).length / dists.length
  const top2Acc = dists.filter((d, i) => topK(d, 2).includes(labels[i])).length / dists.length
  const top3Acc = dists.filter((d, i) => topK(d, 3).includes(labels[i])).length / dists.length
  sweep.push({ T, brier: +brier.toFixed(4), top1Acc, top2Acc, top3Acc })
}

console.log('\nBRANCHING-RATIO CLASS PROBABILITIES — dry run')
console.log('=============================================')
console.log('\nTemperature sweep (lower Brier = better-calibrated)')
console.log('  T        Brier    top1    top2    top3')
for (const s of sweep) {
  console.log(`  ${String(s.T).padStart(5)}    ${s.brier.toFixed(4)}   ${s.top1Acc.toFixed(3)}   ${s.top2Acc.toFixed(3)}   ${s.top3Acc.toFixed(3)}`)
}

// Best T by Brier
const best = sweep.reduce((a, b) => b.brier < a.brier ? b : a)
console.log(`\nBest T by Brier: T=${best.T}  Brier=${best.brier}`)

// Show the asteroid-attractor cases at best T
console.log('\nASTEROID-ATTRACTOR CASES (moon/comet → asteroid in v2)')
const bestDists = ranked.map(r => softmax(r.classification.class_scores, best.T))
let attractorFixed = 0, attractorTotal = 0
for (let i = 0; i < ranked.length; i++) {
  const expected = labels[i]
  const actual   = ranked[i].classification.class
  if ((expected === 'moon' || expected === 'comet') && actual === 'asteroid') {
    attractorTotal++
    const d = bestDists[i]
    const top2 = topK(d, 2)
    const fixed = top2.includes(expected)
    if (fixed) attractorFixed++
    const dStr = CLASSES.map(c => `${c.slice(0, 3)}=${d[c].toFixed(2)}`).join(' ')
    console.log(`  ${ranked[i].slug.padEnd(34)}  expected ${expected.padEnd(10)}  actual ${actual.padEnd(10)}  top2=[${top2.join(',')}] ${fixed ? '✓ in top2' : '✗'}`)
    console.log(`     dist:  ${dStr}`)
  }
}
console.log(`\n  ${attractorFixed}/${attractorTotal} attractor cases have the correct class in top-2`)

// Margin analysis — how confident is the top-1?
console.log('\nMARGIN OF CONFIDENCE  (top1 − top2 prob)')
const margins = bestDists.map(d => {
  const sorted = Object.values(d).sort((a, b) => b - a)
  return sorted[0] - sorted[1]
})
const lowMargin = margins.filter(m => m < 0.10).length
console.log(`  mean margin: ${(margins.reduce((s, v) => s + v, 0) / margins.length).toFixed(3)}`)
console.log(`  low-margin (Δ < 0.10): ${lowMargin}/${ranked.length}  — these are "uncertain" cases`)

// ── Verdict ─────────────────────────────────────────────────────────
console.log('\nVERDICT')
const baselineBrier = sweep.find(s => s.T === 1.0).brier
const improvement = baselineBrier - best.brier
console.log(`  baseline Brier (T=1): ${baselineBrier}`)
console.log(`  best Brier (T=${best.T}): ${best.brier}    Δ = ${improvement.toFixed(4)}`)
console.log(`  top-2 accuracy at best T: ${best.top2Acc.toFixed(3)}  (vs hard class accuracy ${best.top1Acc.toFixed(3)})`)
console.log(`  attractor fix rate: ${attractorFixed}/${attractorTotal} ${attractorTotal ? `(${(100 * attractorFixed / attractorTotal).toFixed(0)}%)` : ''}`)

if (best.top2Acc > best.top1Acc + 0.10 && attractorTotal > 0 && attractorFixed / attractorTotal >= 0.5) {
  console.log('\n  ✓ Branching ratios materially help: top-2 lifts accuracy by >10pp, and ≥50% of')
  console.log('    asteroid-attractor cases recover the correct class. Ship as additive')
  console.log('    `class_distribution` field on the classification output.')
} else if (best.top2Acc > best.top1Acc) {
  console.log('\n  ◐ Branching ratios provide marginal lift on top-2 vs top-1. Worth shipping')
  console.log('    as soft-label output for downstream consumers; not a routing fix.')
} else {
  console.log('\n  ✗ Branching ratios offer no top-2 lift over hard-class. Diagnostic only.')
}
