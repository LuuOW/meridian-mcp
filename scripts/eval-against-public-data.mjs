#!/usr/bin/env node
// Free-data eval — does our v2 classifier work on real labelled
// task → tool data? Pulls 60 rows from `shawhin/tool-use-finetuning`
// (HF datasets-server, no auth) and runs three approaches against
// the labels:
//
//   1. v2 production classifier  — orbitalClassify from mcp/_lib
//   2. trivial token-overlap     — score each tool by Jaccard between
//                                  task tokens and tool description tokens.
//                                  Uses no labels. Establishes a floor.
//   3. random baseline           — picks a tool at random.
//                                  Floor-of-floors.
//
// What we want to learn
// ─────────────────────
// • If v2 ≈ trivial ≈ random: heuristics are at ceiling, labels won't
//   help (probably).
// • If trivial ≫ v2: heuristics are doing worse than literally
//   string-matching, labels would clearly help.
// • If v2 ≫ trivial ≫ random: heuristics carry signal but labels
//   could lift the ceiling further.
// • Anything else: the scoreboard tells the story directly.
//
// Run: node scripts/eval-against-public-data.mjs

import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
import { tokenize, uniq }    from '../mcp/_lib/tokenize.mjs'

const DATASET = 'shawhin/tool-use-finetuning'
const SPLIT   = 'test'   // 60 rows, mix of easy / hard / no_tool
const N_ROWS  = 60       // full test set
const TOP_K   = 5        // recall@5

// ── Fetch dataset rows from the HF datasets-server ─────────────────
async function fetchRows() {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=${SPLIT}&offset=0&length=${N_ROWS}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HF datasets-server ${res.status}: ${await res.text()}`)
  const body = await res.json()
  return body.rows.map(r => r.row)
}

// Each row's `trace[0].content` is the system prompt with a <tools>JSON</tools>
// block listing all available tools for that row's task. Pull them out.
function extractTools(traceJson) {
  const trace = typeof traceJson === 'string' ? JSON.parse(traceJson) : traceJson
  const sys   = trace?.[0]?.content || ''
  const m     = sys.match(/<tools>\s*([\s\S]*?)\s*<\/tools>/)
  if (!m) return []
  try { return JSON.parse(m[1]) }
  catch { return [] }
}

// Convert a tool to our skill shape (slug + description + keywords + body).
// Keywords = description tokens + arg names. Body = synthesised markdown
// since the dataset doesn't ship one — gives the classifier the same
// surface area the real route_task tool gets.
function toolToSkill(tool) {
  const args = tool.input_args || {}
  const argNames = Object.keys(args)
  const descTokens = uniq(tokenize(tool.description || '')).slice(0, 8)
  const keywords = uniq([...argNames, ...descTokens]).slice(0, 10)
  const argLines = argNames.length
    ? argNames.map(a => `- \`${a}\`: ${args[a]}`).join('\n')
    : '- (no args)'
  const body = `## Use It For\n- ${tool.description || tool.tool_name}\n\n## Args\n${argLines}\n\n## Output\nReturns the result of \`${tool.tool_name}\`.`
  return {
    slug:        tool.tool_name,
    name:        tool.tool_name,
    description: tool.description || '',
    keywords,
    body,
  }
}

// ── Trivial baseline — token-overlap (Jaccard) on task vs description ──
function trivialRank(task, skills) {
  const taskToks = new Set(tokenize(task))
  const scored = skills.map(sk => {
    const sToks = new Set([
      ...tokenize(sk.slug),
      ...tokenize(sk.description),
      ...sk.keywords.flatMap(k => tokenize(k)),
    ])
    let inter = 0
    for (const t of taskToks) if (sToks.has(t)) inter++
    const union = new Set([...taskToks, ...sToks]).size
    const j = union ? inter / union : 0
    return { slug: sk.slug, score: j }
  })
  return scored.sort((a, b) => b.score - a.score)
}

// ── Random baseline ─────────────────────────────────────────────────
function randomRank(skills) {
  return skills
    .map(sk => ({ slug: sk.slug, score: Math.random() }))
    .sort((a, b) => b.score - a.score)
}

// ── Run ─────────────────────────────────────────────────────────────
// In --json mode, every human-readable log goes to stderr so stdout
// is pure parseable JSON. The CI workflow redirects stdout into a
// file and parses it; mixed output breaks the parser.
const JSON_MODE = process.argv.includes('--json')
const log = JSON_MODE ? (...a) => console.error(...a) : (...a) => console.log(...a)

const rows = await fetchRows()
log(`Fetched ${rows.length} rows from ${DATASET} (${SPLIT})`)

let evalRows = []
let dropped = 0
for (const r of rows) {
  // Skip no-tool tasks — they're not classification problems with a
  // labelled correct tool.
  if (!r.tool_needed || !r.tool_name) { dropped++; continue }
  const tools = extractTools(r.trace)
  if (tools.length < 2) { dropped++; continue }
  // Confirm the labelled tool is in the candidate set (sanity).
  if (!tools.some(t => t.tool_name === r.tool_name)) { dropped++; continue }
  evalRows.push({
    query:  r.query,
    label:  r.tool_name,
    skills: tools.map(toolToSkill),
    type:   r.query_type,   // 'easy' | 'hard'
  })
}
log(`Eval set: ${evalRows.length} rows  (dropped ${dropped} no-tool / malformed)`)

const results = { v2: { hits1: 0, hits5: 0 }, trivial: { hits1: 0, hits5: 0 }, random: { hits1: 0, hits5: 0 } }
const perRow  = []
// Per-row hit indicators (0/1) — used by the bootstrap CI block below.
const hits = { v2_h1: [], v2_h5: [], trv_h1: [], trv_h5: [], rnd_h1: [], rnd_h5: [] }

for (const ex of evalRows) {
  // 1. v2 classifier — orbitalClassify ranks by route_score.
  const ranked = orbitalClassify(ex.skills, ex.query)
  const v2Rank = ranked.findIndex(r => r.slug === ex.label)

  // 2. Trivial token-overlap baseline.
  const trv = trivialRank(ex.query, ex.skills)
  const trvRank = trv.findIndex(r => r.slug === ex.label)

  // 3. Random.
  const rnd = randomRank(ex.skills)
  const rndRank = rnd.findIndex(r => r.slug === ex.label)

  const v2_h1  = v2Rank  === 0 ? 1 : 0
  const v2_h5  = v2Rank  >= 0 && v2Rank  < TOP_K ? 1 : 0
  const trv_h1 = trvRank === 0 ? 1 : 0
  const trv_h5 = trvRank >= 0 && trvRank < TOP_K ? 1 : 0
  const rnd_h1 = rndRank === 0 ? 1 : 0
  const rnd_h5 = rndRank >= 0 && rndRank < TOP_K ? 1 : 0

  results.v2.hits1      += v2_h1
  results.v2.hits5      += v2_h5
  results.trivial.hits1 += trv_h1
  results.trivial.hits5 += trv_h5
  results.random.hits1  += rnd_h1
  results.random.hits5  += rnd_h5
  hits.v2_h1.push(v2_h1);   hits.v2_h5.push(v2_h5)
  hits.trv_h1.push(trv_h1); hits.trv_h5.push(trv_h5)
  hits.rnd_h1.push(rnd_h1); hits.rnd_h5.push(rnd_h5)

  perRow.push({
    query:    ex.query.slice(0, 70) + (ex.query.length > 70 ? '…' : ''),
    label:    ex.label,
    v2_top:   ranked[0]?.slug || '?',
    trv_top:  trv[0]?.slug    || '?',
    v2_rank:  v2Rank,
    trv_rank: trvRank,
    type:     ex.type,
    nTools:   ex.skills.length,
  })
}

// ── 95% Wilson score interval (closed-form, frequentist) ──────────
//    For binomial proportions, Wilson achieves nominal coverage at
//    n=21 across all p ∈ [0.5, 0.95] (verified by simulate-ci-methods.mjs:
//    bootstrap had only 66% coverage at p=0.95 — under-covers at the
//    extremes; jackknife same problem). Wilson costs zero compute, is
//    well-calibrated, and is the textbook choice for proportions.
function wilsonCI(arr, z = 1.96) {
  const n = arr.length
  if (!n) return { mean: 0, lo: 0, hi: 0 }
  const k = arr.reduce((s, v) => s + v, 0)
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom
  return {
    mean: +p.toFixed(4),
    lo:   +Math.max(0, center - margin).toFixed(4),
    hi:   +Math.min(1, center + margin).toFixed(4),
  }
}
const ci = {
  v2:      { at_1: wilsonCI(hits.v2_h1),  at_5: wilsonCI(hits.v2_h5)  },
  trivial: { at_1: wilsonCI(hits.trv_h1), at_5: wilsonCI(hits.trv_h5) },
  random:  { at_1: wilsonCI(hits.rnd_h1), at_5: wilsonCI(hits.rnd_h5) },
}

const N = evalRows.length
function pct(n) { return (100 * n / N).toFixed(1) + '%' }

// Compute aggregates needed by both --json and human modes. These
// must come BEFORE the --json check so the JSON dump can include
// them, but they don't print anything yet.
const avgTools = perRow.reduce((s, r) => s + r.nTools, 0) / perRow.length
const byType = {}
for (const r of perRow) {
  byType[r.type] = byType[r.type] || { n: 0, v2_h1: 0, trv_h1: 0 }
  byType[r.type].n++
  if (r.v2_rank === 0)  byType[r.type].v2_h1++
  if (r.trv_rank === 0) byType[r.type].trv_h1++
}

// JSON mode: emit pure JSON to stdout, exit. Human mode falls
// through to the formatted console output below.
if (JSON_MODE) {
  process.stdout.write(JSON.stringify({
    dataset: DATASET, split: SPLIT, n_eval: N,
    avg_candidates_per_row: +avgTools.toFixed(2),
    recall: {
      v2:      { at_1: results.v2.hits1 / N,      at_5: results.v2.hits5 / N      },
      trivial: { at_1: results.trivial.hits1 / N, at_5: results.trivial.hits5 / N },
      random:  { at_1: results.random.hits1 / N,  at_5: results.random.hits5 / N  },
    },
    recall_ci_95: ci,
    ci_method: 'wilson',
    by_type: byType,
    generated_at: new Date().toISOString(),
  }, null, 2) + '\n')
  process.exit(0)
}

function fmtCI(c) { return `${c.mean.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]` }

console.log(`\nRECALL@1   point [95% Wilson CI]   ·   RECALL@${TOP_K}`)
console.log(`  v2 classifier   ${fmtCI(ci.v2.at_1)}   ${fmtCI(ci.v2.at_5)}`)
console.log(`  trivial overlap ${fmtCI(ci.trivial.at_1)}   ${fmtCI(ci.trivial.at_5)}`)
console.log(`  random          ${fmtCI(ci.random.at_1)}   ${fmtCI(ci.random.at_5)}`)
console.log(`\nAvg candidate tools per row: ${avgTools.toFixed(1)}  (random@1 expected ≈ ${(100 / avgTools).toFixed(1)}%)`)
console.log('\nBY QUERY TYPE')
for (const [t, s] of Object.entries(byType)) {
  console.log(`  ${t.padEnd(10)} n=${s.n}   v2@1 ${s.v2_h1}/${s.n} (${(100 * s.v2_h1 / s.n).toFixed(0)}%)   trivial@1 ${s.trv_h1}/${s.n} (${(100 * s.trv_h1 / s.n).toFixed(0)}%)`)
}

// Cases where trivial beat v2 (signal that labels could lift us).
console.log('\nCASES WHERE TRIVIAL TOKEN-OVERLAP BEAT V2')
let beats = 0
for (const r of perRow) {
  if (r.trv_rank >= 0 && (r.trv_rank < r.v2_rank || r.v2_rank < 0) && r.trv_rank === 0 && r.v2_rank !== 0) {
    if (beats < 8) {
      console.log(`  query:   ${r.query}`)
      console.log(`  label:   ${r.label}      v2 top:    ${r.v2_top} (rank ${r.v2_rank})`)
      console.log(`                            trivial:   ${r.trv_top} (rank ${r.trv_rank})\n`)
    }
    beats++
  }
}
console.log(`(${beats} total)`)

// Verdict — uses CI separation, not raw counts. With n=21 the point
// estimate has ~±19pp bootstrap error bars, so a 2-hit lead means
// nothing.
console.log('\nVERDICT')
const v2_clear_lead = ci.v2.at_1.lo  > ci.trivial.at_1.hi    // v2 lower > trv upper
const trv_clear_lead = ci.trivial.at_1.lo > ci.v2.at_1.hi
const v2_clear_above_random = ci.v2.at_1.lo > ci.random.at_1.hi
const v2_lead_overlap = (ci.v2.at_1.mean > ci.trivial.at_1.mean) && !v2_clear_lead
if (!v2_clear_above_random) {
  console.log('  • v2 CI overlaps with random — heuristic carries no signal on this data.')
} else if (trv_clear_lead) {
  console.log('  • Trivial token-overlap unambiguously beats v2 (CI separation).')
  console.log('  • Reading: classifier underperforms a 5-line baseline. Labelled fitting needed.')
} else if (v2_clear_lead) {
  console.log('  • v2 unambiguously beats trivial token-overlap (CI separation).')
  console.log('  • Reading: heuristics carry signal even after accounting for sample noise.')
} else if (v2_lead_overlap) {
  console.log('  • v2 leads on point estimate but Wilson CIs overlap with trivial.')
  console.log(`  • Reading: with n=${N} we can't statistically separate them. Need more labelled rows`)
  console.log('    to confirm the lead is real, not a small-sample artefact.')
} else {
  console.log('  • v2 ≈ trivial on point estimate. Heuristics at ceiling on this dataset.')
}
