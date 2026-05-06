#!/usr/bin/env node
// Meridian Skills MCP — stdio server, fully self-contained.
//
// On every route_task call:
//   1. Llama-3.3-70B (via GitHub Models) generates 5 candidate SKILL.md
//      shapes for the task — slug, description, keywords, body.
//   2. The bundled orbital classifier ranks the candidates and assigns
//      each a celestial class (planet / moon / trojan / asteroid / comet
//      / irregular), parent, star system, and lagrange potential.
//   3. The ranked list is returned as agent-readable markdown with each
//      skill's full body inline so the caller LLM can lift it straight
//      into its context window.
//
// No backend, no Cloudflare Worker, no curated corpus, no Python. The
// only network call is to GitHub Models. Set MERIDIAN_GITHUB_TOKEN (or
// GITHUB_TOKEN) — a fine-grained PAT with `Models: read` is enough.

import { Server }              from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { orbitalClassify } from './_lib/orbital.mjs'

const PKG_VERSION = '2.0.0'

// GitHub Models — free tier, generous rate limit. The endpoint speaks
// the OpenAI chat-completions shape. Default model is the strongest
// open-weight option; user can override.
const MODELS_ENDPOINT = process.env.MERIDIAN_MODELS_ENDPOINT
  || 'https://models.github.ai/inference/chat/completions'
const MODEL = process.env.MERIDIAN_MODEL || 'meta/llama-3.3-70b-instruct'
const TOKEN = process.env.MERIDIAN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ''
const TIMEOUT  = parseInt(process.env.MERIDIAN_TIMEOUT_MS || '90000', 10)
const CANDIDATES = parseInt(process.env.MERIDIAN_CANDIDATES || '5', 10)

const server = new Server(
  { name: 'meridian-skills', version: PKG_VERSION },
  { capabilities: { tools: {} } },
)

const TOOLS = [
  {
    name: 'route_task',
    description:
      'Route a task to the most relevant skills. An LLM (Llama-3.3-70B via GitHub Models) generates fresh skill candidates, then a local orbital classifier ranks each into a celestial class (planet/moon/trojan/asteroid/comet/irregular) and returns the top matches with full markdown bodies, classification metadata, physics signature, and decision rule. ⚠ Each call typically takes 5–15 s. Returns at most `limit` skills (default 5).',
    inputSchema: {
      type: 'object',
      properties: {
        task:  { type: 'string',  description: 'Task / question / context. Up to 800 chars.' },
        limit: { type: 'integer', description: 'Max skills to return (1–10, default 5)', default: 5 },
      },
      required: ['task'],
    },
  },
]

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name !== 'route_task') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }

  const task  = (args.task || '').toString().trim()
  const limit = Math.max(1, Math.min(10, parseInt(args.limit, 10) || 5))
  if (!task)             return errorContent('task required')
  if (task.length > 800) return errorContent('task too long (max 800)')
  if (!TOKEN) return errorContent('Set MERIDIAN_GITHUB_TOKEN (or GITHUB_TOKEN) to a GitHub PAT with `Models: read` permission. Get one at https://github.com/settings/personal-access-tokens/new.')

  try {
    const t0 = Date.now()
    const candidates = await generateCandidates(task, CANDIDATES)
    const t1 = Date.now()
    const ranked = orbitalClassify(candidates, task)
    const top = ranked.slice(0, limit)
    const t2 = Date.now()

    const top_score  = top[0]?.route_score || 0
    const confidence = top_score >= 30 ? 'strong' : top_score >= 8 ? 'moderate' : 'weak'

    return {
      content: [{ type: 'text', text: formatResult({
        task,
        confidence,
        top_score,
        candidates_generated: candidates.length,
        selected: top,
        timing: { llm_ms: t1 - t0, classify_ms: t2 - t1, total_ms: t2 - t0 },
      }) }],
    }
  } catch (e) {
    return errorContent(`route_task failed: ${e.message || e}`)
  }
})

const SYSTEM_PROMPT = `You generate "SKILL.md" candidate documents for an AI agent's tool registry.

For the user's task, propose ${CANDIDATES} candidate skills the agent might load. Each skill is a self-contained capability with a slug, one-line description, list of relevant keywords, and a markdown body that walks the agent through "Use it for", "Workflow", and any "Pitfalls".

Respond with a JSON object:
{
  "skills": [
    {
      "slug": "kebab-case-id",
      "description": "one sentence explaining what this skill does",
      "keywords": ["term1", "term2", "..."],
      "body": "## Use It For\\n- ...\\n\\n## Workflow\\n1. ...\\n\\n## Pitfalls\\n- ...\\n"
    }
  ]
}

Rules:
- Generate exactly ${CANDIDATES} candidates.
- Slugs must be unique kebab-case strings.
- Keywords are 4–10 short terms relevant to retrieval.
- Body is concrete, action-oriented markdown with the three sections above.
- Skills should be diverse — different angles on the task — not minor variations.
- No prose outside the JSON.`

async function generateCandidates(task, n) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(MODELS_ENDPOINT, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'user-agent': `meridian-skills-mcp/${PKG_VERSION}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `Task: ${task}\n\nGenerate ${n} candidate skills.` },
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
    catch (e) {
      // Strip ```json fences if present and retry.
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
      parsed = JSON.parse(cleaned)
    }
    const skills = Array.isArray(parsed.skills) ? parsed.skills : []
    if (!skills.length) throw new Error('LLM produced no skills')
    return skills.map(s => ({
      slug:        String(s.slug || '').slice(0, 80),
      name:        String(s.slug || ''),
      description: String(s.description || ''),
      keywords:    Array.isArray(s.keywords) ? s.keywords.map(String).slice(0, 12) : [],
      body:        String(s.body || ''),
    }))
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout after ${TIMEOUT} ms (set MERIDIAN_TIMEOUT_MS to increase)`)
    throw e
  } finally {
    clearTimeout(timer)
  }
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

  const skills = (r.selected || []).map((s, i) => {
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

  return header + skills
}

function errorContent(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
}

const transport = new StdioServerTransport()
await server.connect(transport)
