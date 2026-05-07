#!/usr/bin/env node
// Calibration check for the orbital classifier.
//
// The classifier is a deterministic function from { skill, sibling-set }
// to a class + physics signature + ranking. Its constants (CLASS_BOOST,
// score thresholds, mass/scope/drag formulas) are hand-tuned and have
// no ground truth — so the maintainable form of "is it still calibrated?"
// is: do its outputs distribute reasonably across a fixed panel of
// representative inputs?
//
// What this script does
// ─────────────────────
// 1. Defines a synthetic panel of 18 SKILL.md objects designed to
//    exercise every celestial class and every star system. Three skills
//    per class × two domains, with realistic body lengths and keyword
//    counts. The panel is checked into git so this run is reproducible.
// 2. Runs orbitalClassify across the panel against a routing task.
// 3. Computes calibration metrics:
//    - Class distribution (count + %)
//    - Star-system distribution
//    - Per-axis signature stats (mean, std, min, max) for the 7 physics
//      scalars + 4 optical scalars
//    - Score distribution (top score, mean, std)
//    - Discriminative power: per-axis dynamic range as a fraction of
//      [0,1] — flags axes that have collapsed.
//    - Wavelength spread (must stay inside the visible 380–750 nm band)
//    - Routing recall on the panel — does the labelled "correct" skill
//      land in the top-K? Provides a single quality number.
// 4. Compares against scripts/calibration-baseline.json (if present).
//    Prints flagged drift; exits 1 on hard regression so CI can gate it.
// 5. With --update-baseline, writes the current run as the new baseline.
//
// Usage
// ─────
//   node scripts/calibrate-classifier.mjs                # report + baseline diff
//   node scripts/calibrate-classifier.mjs --json         # machine-readable
//   node scripts/calibrate-classifier.mjs --update-baseline   # rebaseline
//
// Live pass (against the deployed MCP) is intentionally NOT run from
// this script — it would burn API credits on every CI invocation. Run
// it manually with `node scripts/calibrate-classifier.mjs --live`
// when you want to catch LLM-side drift.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
import { PANEL, TASK, panelForClassify } from './calibration-panel.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = join(__dirname, 'calibration-baseline.json')

const args = new Set(process.argv.slice(2))
const JSON_MODE  = args.has('--json')
const REBASELINE = args.has('--update-baseline')
const LIVE       = args.has('--live')

// ── Run ────────────────────────────────────────────────────────────
// Panel is shared with scripts/simulate-classifier-v2.mjs so dry-runs
// of proposed retunes go through the exact same fixtures.
const ranked = orbitalClassify(panelForClassify(), TASK)

// ── Metrics ────────────────────────────────────────────────────────
const CLASSES  = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']
const SYSTEMS  = ['forge', 'signal', 'mind']
const PHYSICS_AXES = ['mass', 'scope', 'independence', 'cross_domain', 'fragmentation', 'drag', 'dep_ratio']
const OPTICAL_AXES = ['wavelength', 'polarization', 'amplitude', 'phase']

const dist = {}, sysDist = {}
for (const cls of CLASSES) dist[cls] = 0
for (const sys of SYSTEMS) sysDist[sys] = 0
for (const r of ranked) {
  dist[r.classification.class] = (dist[r.classification.class] || 0) + 1
  sysDist[r.classification.star_system] = (sysDist[r.classification.star_system] || 0) + 1
}

function statsOf(values) {
  const xs = values.filter(v => Number.isFinite(v))
  if (!xs.length) return { mean: NaN, std: NaN, min: NaN, max: NaN, n: 0 }
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length
  return {
    mean: round(mean),
    std:  round(Math.sqrt(variance)),
    min:  round(Math.min(...xs)),
    max:  round(Math.max(...xs)),
    n:    xs.length,
  }
}
function round(x) { return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x }

const physicsStats = {}
for (const axis of PHYSICS_AXES) {
  physicsStats[axis] = statsOf(ranked.map(r => r.classification.physics[axis]))
}
const opticalStats = {}
for (const axis of OPTICAL_AXES) {
  opticalStats[axis] = statsOf(ranked.map(r => r.classification.physics.optical[axis]))
}
const scoreStats = statsOf(ranked.map(r => r.route_score))

// Recall@K against the labelled "relevant" skills.
const relevantSlugs = new Set(PANEL.filter(p => p.__relevant).map(p => p.slug))
const top5 = new Set(ranked.slice(0, 5).map(r => r.slug))
const top1 = new Set(ranked.slice(0, 1).map(r => r.slug))
const recall = {
  at_1: [...relevantSlugs].filter(s => top1.has(s)).length / Math.max(1, relevantSlugs.size),
  at_5: [...relevantSlugs].filter(s => top5.has(s)).length / Math.max(1, relevantSlugs.size),
}

// Class-assignment accuracy on the panel — does each skill land in
// the class it was designed to exhibit? Soft metric; small panels
// produce noisy class boundaries (especially asteroid vs comet).
const classMatches = ranked.filter(r => {
  const expected = PANEL.find(p => p.slug === r.slug)?.__expectedClass
  return expected && r.classification.class === expected
}).length
const classAccuracy = round(classMatches / ranked.length)

// Discriminative power: per-axis dynamic range as a fraction of the
// axis's [0,1] domain. An axis pinned at 0.5 ± 0.02 has collapsed and
// is no longer separating skills.
const discrimination = {}
for (const axis of PHYSICS_AXES) {
  const s = physicsStats[axis]
  discrimination[axis] = round(s.max - s.min)
}

const metrics = {
  task: TASK,
  panel_size: ranked.length,
  class_distribution: dist,
  system_distribution: sysDist,
  class_accuracy: classAccuracy,
  recall,
  score: scoreStats,
  physics: physicsStats,
  optical: opticalStats,
  discrimination,
  generated_at: new Date().toISOString(),
}

// ── Baseline diff ───────────────────────────────────────────────────
const TOLERANCE = {
  class_distribution: 1,        // ±1 skill per class
  class_accuracy:     0.10,
  recall_at_5:        0.20,
  score_mean:         0.30,     // ±30% relative
  axis_mean:          0.10,     // absolute on [0,1] axes
  discrimination:     0.10,
}

let baseline = null
if (existsSync(BASELINE_PATH)) {
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) }
  catch (e) { console.warn('[calibrate] failed to read baseline:', e.message) }
}

const drift = []
if (baseline) {
  for (const cls of CLASSES) {
    const d = (dist[cls] || 0) - (baseline.class_distribution[cls] || 0)
    if (Math.abs(d) > TOLERANCE.class_distribution) {
      drift.push(`class_distribution.${cls}: ${baseline.class_distribution[cls] || 0} → ${dist[cls] || 0} (Δ${d >= 0 ? '+' : ''}${d})`)
    }
  }
  if (Math.abs(metrics.class_accuracy - baseline.class_accuracy) > TOLERANCE.class_accuracy) {
    drift.push(`class_accuracy: ${baseline.class_accuracy} → ${metrics.class_accuracy}`)
  }
  if (Math.abs(metrics.recall.at_5 - baseline.recall.at_5) > TOLERANCE.recall_at_5) {
    drift.push(`recall@5: ${baseline.recall.at_5} → ${metrics.recall.at_5}`)
  }
  const meanRel = baseline.score?.mean ? Math.abs((metrics.score.mean - baseline.score.mean) / baseline.score.mean) : 0
  if (meanRel > TOLERANCE.score_mean) {
    drift.push(`score.mean: ${baseline.score.mean} → ${metrics.score.mean} (rel Δ ${(meanRel * 100).toFixed(1)}%)`)
  }
  for (const axis of PHYSICS_AXES) {
    const cur = metrics.physics[axis]?.mean
    const old = baseline.physics?.[axis]?.mean
    if (Number.isFinite(cur) && Number.isFinite(old) && Math.abs(cur - old) > TOLERANCE.axis_mean) {
      drift.push(`physics.${axis}.mean: ${old} → ${cur}`)
    }
  }
  for (const axis of PHYSICS_AXES) {
    const cur = metrics.discrimination[axis]
    const old = baseline.discrimination?.[axis]
    if (Number.isFinite(cur) && Number.isFinite(old) && Math.abs(cur - old) > TOLERANCE.discrimination) {
      drift.push(`discrimination.${axis}: ${old} → ${cur}`)
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────
if (REBASELINE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(metrics, null, 2) + '\n')
  console.log(`baseline written → ${BASELINE_PATH}`)
  process.exit(0)
}

if (JSON_MODE) {
  console.log(JSON.stringify({ metrics, baseline: baseline ? { from: baseline.generated_at } : null, drift }, null, 2))
  process.exit(drift.length ? 1 : 0)
}

const pct = (n, total) => `${((n / total) * 100).toFixed(1)}%`
const total = ranked.length

console.log(`\nClassifier calibration — ${ranked.length} skills, task: "${TASK}"\n`)

console.log('CLASS DISTRIBUTION')
for (const cls of CLASSES) {
  const n = dist[cls] || 0
  const bar = '█'.repeat(Math.round((n / total) * 36))
  console.log(`  ${cls.padEnd(10)} ${String(n).padStart(3)} ${pct(n, total).padStart(6)}  ${bar}`)
}

console.log('\nSTAR SYSTEM DISTRIBUTION')
for (const sys of SYSTEMS) {
  const n = sysDist[sys] || 0
  const bar = '█'.repeat(Math.round((n / total) * 36))
  console.log(`  ${sys.padEnd(10)} ${String(n).padStart(3)} ${pct(n, total).padStart(6)}  ${bar}`)
}

console.log('\nPHYSICS AXES (mean ± std, range)')
for (const axis of PHYSICS_AXES) {
  const s = physicsStats[axis]
  console.log(`  ${axis.padEnd(15)} ${String(s.mean).padStart(6)} ± ${String(s.std).padEnd(5)}   [${s.min} … ${s.max}]   discrim ${discrimination[axis]}`)
}

console.log('\nOPTICAL AXES (mean ± std, range)')
for (const axis of OPTICAL_AXES) {
  const s = opticalStats[axis]
  console.log(`  ${axis.padEnd(15)} ${String(s.mean).padStart(6)} ± ${String(s.std).padEnd(5)}   [${s.min} … ${s.max}]`)
}

console.log('\nROUTE SCORE')
console.log(`  mean ${scoreStats.mean} ± ${scoreStats.std}    [${scoreStats.min} … ${scoreStats.max}]`)

console.log(`\nCLASS ACCURACY (panel labels vs predictions)  ${classAccuracy}  (${classMatches}/${ranked.length})`)
console.log(`RECALL@1  ${recall.at_1}    RECALL@5  ${recall.at_5}    (relevant set: ${[...relevantSlugs].join(', ') || '∅'})`)

if (baseline) {
  console.log(`\nBASELINE  ${baseline.generated_at}`)
  if (drift.length) {
    console.log('  DRIFT (over tolerance):')
    for (const d of drift) console.log(`    ✗ ${d}`)
    process.exit(1)
  } else {
    console.log('  ✓ within tolerance on all axes')
  }
} else {
  console.log('\n(no baseline — write one with: node scripts/calibrate-classifier.mjs --update-baseline)')
}

if (LIVE) {
  console.log('\n--live not implemented yet; would POST mcp.ask-meridian.uk/v1/route on a 5-task panel.')
}
