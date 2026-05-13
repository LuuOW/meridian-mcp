// Browser-side equivalent of mcp/_lib/core.mjs's routeTaskJson.
//
// Same prompt + parsing + orbital ranker, but the candidate-generation
// LLM runs in-browser via transformers.js (Llama-3.2-3B-Instruct) rather
// than POSTing to GitHub Models. Result shape is identical so callers
// (miniapp/api.js, lens/meridian-route.mjs) can swap servers ↔ browser
// without changing downstream code.

import { loadLLM } from './edge-inference.mjs'
import { orbitalClassify } from './orbital.mjs'

const SYSTEM_PROMPT = (n) => `You are a candidate generator for an orbital task router. Given a task, output ${n} diverse candidate entries that could plausibly handle it.

Respond with a JSON object:
{
  "candidates": [
    {
      "slug": "kebab-case-id",
      "description": "one sentence explaining what this candidate does",
      "keywords": ["term1", "term2", "..."],
      "body": "## Use It For\\n- ...\\n\\n## Workflow\\n1. ...\\n\\n## Pitfalls\\n- ..."
    }
  ]
}

Rules:
- Generate exactly ${n} candidates.
- Slugs are unique kebab-case.
- Keywords are 4–10 short retrieval terms.
- Body is concrete, action-oriented markdown with the three sections above.
- Candidates should be diverse — different angles on the task — not minor variations.
- No prose outside the JSON.`

// Generate n candidates locally with Llama-3.2-3B. Returns the same
// shape generateCandidates() in core.mjs returns.
async function generateCandidatesLocal(task, n, { onStage } = {}) {
  onStage?.('llm_warming_start', { model: 'Llama-3.2-3B-Instruct' })
  const { tokenizer, model } = await loadLLM()
  onStage?.('llm_calling', { model: 'Llama-3.2-3B-Instruct' })

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(n) },
    { role: 'user',   content: `Task: ${task}\n\nGenerate ${n} candidates.` },
  ]
  const text   = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false })
  const inputs = tokenizer(text, { return_tensors: 'pt' })

  const out = await model.generate({
    ...inputs,
    max_new_tokens: 1024,
    do_sample: false,
    temperature: 0,
  })
  const decoded = tokenizer.batch_decode(out, { skip_special_tokens: true })[0]
  const completion = decoded.slice(text.length).trim()

  // Llama sometimes wraps JSON in ```json fences; strip both forms.
  let parsed
  const fenced = completion.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const raw    = fenced ? fenced[1] : completion
  const obj    = raw.match(/\{[\s\S]*\}/)
  if (!obj) throw new Error(`LLM returned no JSON. Raw: ${completion.slice(0, 200)}`)
  parsed = JSON.parse(obj[0])

  const list = Array.isArray(parsed.candidates) ? parsed.candidates
             : Array.isArray(parsed.skills)     ? parsed.skills
             : []
  if (!list.length) throw new Error('LLM produced no candidates')

  return list.map(s => ({
    slug:        String(s.slug || '').slice(0, 80),
    name:        String(s.slug || ''),
    description: String(s.description || ''),
    keywords:    Array.isArray(s.keywords) ? s.keywords.map(String).slice(0, 12) : [],
    body:        String(s.body || ''),
  }))
}

// Same return shape as core.mjs's routeTaskJson — so client code can
// swap server↔browser by changing the import line.
export async function routeTaskBrowser({ task, limit = 5, candidates: nCandidates = 5, onStage } = {}) {
  const t   = (task || '').toString().trim()
  const lim = Math.max(1, Math.min(10, parseInt(limit, 10) || 5))
  if (!t)             throw new Error('task required')
  if (t.length > 800) throw new Error('task too long (max 800)')

  const t0 = Date.now()
  const candidates = await generateCandidatesLocal(t, nCandidates, { onStage })
  const t1 = Date.now()
  onStage?.('classifying', { n: candidates.length })
  const ranked = orbitalClassify(candidates, t)
  const top    = ranked.slice(0, lim)
  const t2 = Date.now()

  const top_score  = top[0]?.route_score || 0
  const confidence = top_score >= 30 ? 'strong' : top_score >= 8 ? 'moderate' : 'weak'

  onStage?.('done', { confidence, top_score })
  return {
    task: t,
    confidence,
    top_score,
    candidates_generated: candidates.length,
    selected: top,
    candidates: top,
    skills: top,  // legacy alias
    timing: { llm_ms: t1 - t0, classify_ms: t2 - t1, total_ms: t2 - t0 },
  }
}

// Fire-and-forget feedback — browser version is a no-op for now (no
// server-side learner in this deployment). Kept so callers don't break.
export async function sendFeedbackBrowser(/* eventType, payload */) {
  // intentionally no-op
}
