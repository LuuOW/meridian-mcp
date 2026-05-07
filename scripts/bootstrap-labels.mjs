#!/usr/bin/env node
// Bootstrap-labels job — pulls labelled (task → tool) examples from a
// public Hugging Face dataset, classifies the candidate tools through
// our orbital classifier (locally, in this Action runner), and POSTs
// each example to mcp.ask-meridian.uk/v1/feedback. Each POST is one
// pairwise-ranking SGD step in the Worker, so the fitted weights
// drift toward agreeing with real labelled human-validated data.
//
// Runs in GitHub Actions on a cron (see .github/workflows/classifier-bootstrap.yml).
// Pure cloud compute, free Actions minutes, no local execution.
//
// Source dataset: shawhin/tool-use-finetuning. Apache-2.0, 60 rows
// in test split, ~21 with single-correct-tool labels. We refresh
// labels by re-running on each cron tick — KV state grows with the
// model's update count.

import { orbitalClassify } from '../mcp/_lib/orbital.mjs'
import { tokenize, uniq }    from '../mcp/_lib/tokenize.mjs'

const DATASET     = 'shawhin/tool-use-finetuning'
const SPLIT       = 'test'
const N_ROWS      = 60
const FEEDBACK_URL = process.env.MERIDIAN_FEEDBACK_URL  || 'https://mcp.ask-meridian.uk/v1/feedback'
const FEEDBACK_ORIGIN = process.env.MERIDIAN_FEEDBACK_ORIGIN || 'https://ask-meridian.uk'

async function fetchRows() {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=${SPLIT}&offset=0&length=${N_ROWS}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HF datasets-server ${res.status}: ${await res.text()}`)
  return (await res.json()).rows.map(r => r.row)
}

function extractTools(traceJson) {
  const trace = typeof traceJson === 'string' ? JSON.parse(traceJson) : traceJson
  const sys   = trace?.[0]?.content || ''
  const m     = sys.match(/<tools>\s*([\s\S]*?)\s*<\/tools>/)
  if (!m) return []
  try { return JSON.parse(m[1]) }
  catch { return [] }
}

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

async function postFeedback(query, ranked, chosen_slug) {
  // Worker's /v1/feedback expects the same `selected` shape /v1/route
  // returns. orbitalClassify already produces that shape modulo the
  // wrapper, so we pass the ranked array directly.
  //
  // Retry-on-5xx with exponential backoff handles the race when the
  // bootstrap workflow fires on the same push that's still rolling
  // out the worker — first attempt may hit a stale build returning
  // 502/503 for a few seconds.
  const payload = JSON.stringify({ query, selected: ranked, chosen_slug, action: 'bootstrap' })
  // Cloudflare Bot Fight Mode flags GitHub Actions runners by TLS
  // fingerprint. A browser-y UA helps in some cases; doesn't fix
  // fingerprinting but cuts down on naive UA-string blocks.
  const headers = {
    'content-type': 'application/json',
    'origin':       FEEDBACK_ORIGIN,
    'user-agent':   'Mozilla/5.0 (compatible; meridian-bootstrap/1.0)',
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(FEEDBACK_URL, { method: 'POST', headers, body: payload })
    if (res.ok || res.status < 500) {
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
    }
    // 5xx — wait + retry. 1s, 2s, 4s.
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
  }
  return { ok: false, status: 599, body: { error: 'gave up after 4 retries' } }
}

const rows = await fetchRows()
console.log(`[bootstrap] fetched ${rows.length} rows from ${DATASET} (${SPLIT})`)

let posted = 0, skipped = 0, failed = 0, applied = 0
for (const r of rows) {
  if (!r.tool_needed || !r.tool_name) { skipped++; continue }
  const tools = extractTools(r.trace)
  if (tools.length < 2) { skipped++; continue }
  if (!tools.some(t => t.tool_name === r.tool_name)) { skipped++; continue }

  const skills = tools.map(toolToSkill)
  const ranked = orbitalClassify(skills, r.query)
  const result = await postFeedback(r.query, ranked, r.tool_name)
  if (!result.ok) {
    failed++
    if (failed <= 3) console.warn(`[bootstrap] FAIL  ${result.status}  ${JSON.stringify(result.body).slice(0, 200)}`)
    continue
  }
  posted++
  if (result.body.applied) applied++
}

console.log(`[bootstrap] done: ${posted} posted, ${applied} applied, ${skipped} skipped, ${failed} failed`)
process.exit(failed > 0 && posted === 0 ? 1 : 0)
