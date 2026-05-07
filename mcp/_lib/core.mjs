// Shared core for the Meridian MCP — used by both transports
// (stdio in mcp/index.mjs, HTTP in mcp/http.mjs). The token is a
// per-call argument so the HTTP transport can pass through whatever
// arrived in the Authorization header without touching env state.

import { orbitalClassify } from './orbital.mjs'

export const PKG_VERSION = '3.0.0'

// Workers don't expose `process` by default — read defensively so this
// module imports cleanly in CF Workers, Deno, Bun, and plain browsers.
const env = globalThis.process?.env || {}

export const DEFAULTS = {
  endpoint:   env.MERIDIAN_MODELS_ENDPOINT || 'https://models.github.ai/inference/chat/completions',
  model:      env.MERIDIAN_MODEL          || 'meta/llama-3.3-70b-instruct',
  timeoutMs:  parseInt(env.MERIDIAN_TIMEOUT_MS || '90000', 10),
  candidates: parseInt(env.MERIDIAN_CANDIDATES || '5', 10),
}

export const TOOLS = [
  {
    name: 'route_task',
    description:
      'Route a task to relevant candidates. An LLM (Llama-3.3-70B via GitHub Models) generates fresh candidate entries, then a local orbital classifier ranks each into a celestial body class (planet/moon/trojan/asteroid/comet/irregular) and returns the top matches with full markdown bodies, classification metadata, physics signature, and decision rule. Candidates can be tools, prompts, documents, products, or any routable entity — the classifier is domain-agnostic. ⚠ Each call typically takes 5–15 s. Returns at most `limit` candidates (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        task:  { type: 'string',  description: 'Task / question / context. Up to 800 chars.' },
        limit: { type: 'integer', description: 'Max candidates to return (1–10, default 5)', default: 5 },
      },
      required: ['task'],
    },
  },
]

const systemPrompt = (n) => `You generate candidate routing entries for an orbital task router.

For the user's task, propose ${n} candidates that could fulfill it. A candidate is any routable entity — a tool, a prompt, a document, a product, a workflow — with a slug, one-line description, list of relevant keywords, and a markdown body covering "Use it for", "Workflow", and "Pitfalls".

Respond with a JSON object:
{
  "candidates": [
    {
      "slug": "kebab-case-id",
      "description": "one sentence explaining what this candidate does",
      "keywords": ["term1", "term2", "..."],
      "body": "## Use It For\\n- ...\\n\\n## Workflow\\n1. ...\\n\\n## Pitfalls\\n- ...\\n"
    }
  ]
}

Rules:
- Generate exactly ${n} candidates.
- Slugs must be unique kebab-case strings.
- Keywords are 4–10 short terms relevant to retrieval.
- Body is concrete, action-oriented markdown with the three sections above.
- Candidates should be diverse — different angles on the task — not minor variations.
- Do not assume candidates must be AI-agent capabilities; they can be any kind of routable entity.
- No prose outside the JSON.`

async function generateCandidates(task, n, { token, endpoint, model, timeoutMs }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': `meridian-mcp/${PKG_VERSION}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(n) },
          { role: 'user',   content: `Task: ${task}\n\nGenerate ${n} candidates.` },
        ],
      }),
      signal: ctrl.signal,
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error?.message || body.message || `HTTP ${res.status}`)
    const text = body.choices?.[0]?.message?.content
    if (!text) throw new Error('LLM returned empty content')
    let parsed
    try { parsed = JSON.parse(text) }
    catch {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
      parsed = JSON.parse(cleaned)
    }
    // Accept either `candidates` (current) or `skills` (legacy fallback for
    // older models that still emit the old key).
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
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout after ${timeoutMs} ms (set MERIDIAN_TIMEOUT_MS to increase)`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Structured pipeline. Returns the full result object so non-MCP
// transports (e.g. the browser-facing /v1/route endpoint that serves
// lens.ask-meridian.uk) can render orbits directly from the classifier
// output without round-tripping through markdown formatting.
export async function routeTaskJson({ task, limit, token, opts = {} }) {
  const t = (task || '').toString().trim()
  const lim = Math.max(1, Math.min(10, parseInt(limit, 10) || 5))
  if (!t)             throw new Error('task required')
  if (t.length > 800) throw new Error('task too long (max 800)')
  if (!token)         throw new Error('Set MERIDIAN_GITHUB_TOKEN (or GITHUB_TOKEN) to a GitHub PAT with `Models: read` permission. Get one at https://github.com/settings/personal-access-tokens/new.')

  const cfg = {
    token,
    endpoint:   opts.endpoint   || DEFAULTS.endpoint,
    model:      opts.model      || DEFAULTS.model,
    timeoutMs:  opts.timeoutMs  || DEFAULTS.timeoutMs,
    candidates: opts.candidates || DEFAULTS.candidates,
  }

  const t0 = Date.now()
  const candidates = await generateCandidates(t, cfg.candidates, cfg)
  const t1 = Date.now()
  const ranked = orbitalClassify(candidates, t)
  const top = ranked.slice(0, lim)
  const t2 = Date.now()

  const top_score  = top[0]?.route_score || 0
  const confidence = top_score >= 30 ? 'strong' : top_score >= 8 ? 'moderate' : 'weak'

  return {
    task: t,
    confidence,
    top_score,
    candidates_generated: candidates.length,
    selected: top,
    timing: { llm_ms: t1 - t0, classify_ms: t2 - t1, total_ms: t2 - t0 },
  }
}

// MCP entry point — wraps routeTaskJson() in the markdown formatter
// expected by the MCP tool-call response shape.
export async function routeTask(args) {
  return formatResult(await routeTaskJson(args))
}

function formatResult(r) {
  const header = [
    `# Orbital routing result`,
    `Task: ${r.task}`,
    `Confidence: ${r.confidence}  ·  top score ${r.top_score?.toFixed?.(1) ?? '?'}`,
    `Timing: LLM ${r.timing.llm_ms} ms · classify ${r.timing.classify_ms} ms · total ${r.timing.total_ms} ms`,
    `${r.selected?.length ?? 0} of ${r.candidates_generated} candidate(s) selected`,
    '',
  ].filter(Boolean).join('\n')

  const candidatesMd = (r.selected || []).map((s, i) => {
    const c = s.classification || {}
    const meta = [
      `class: ${c.class || '?'}`,
      c.parent      ? `parent: ${c.parent}`           : null,
      c.star_system ? `system: ${c.star_system}`     : null,
      `score: ${s.route_score?.toFixed?.(1) ?? '?'}`,
    ].filter(Boolean).join('  ·  ')

    return [
      `## ${i + 1}. ${s.slug}`,
      meta,
      c.decision_rule ? `> ${c.decision_rule}` : '',
      '',
      s.description || '',
      '',
      s.body || '',
      s.keywords?.length
        ? `\n**keywords**: ${s.keywords.map(k => '`' + k + '`').join(' ')}`
        : '',
      '',
    ].filter(Boolean).join('\n')
  }).join('\n---\n\n')

  return header + candidatesMd
}
