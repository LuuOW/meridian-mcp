// POST /api/orbital-route
// Body: { task, limit?, candidates? }
//
// Pipeline:
//   1. Workers AI (Llama-3.1-8b) generates `candidates` (default 12) skill
//      candidates as { slug, description, keywords, body }.
//   2. JS open-domain orbital classifier (./_orbital.js) computes physics
//      signatures, assigns celestial class (planet/moon/asteroid/trojan/
//      comet/irregular), parents, star-system membership, Lagrange
//      potential, and routes them against the task.
//   3. Top `limit` returned with full classification + scoring breakdown.
//
// No static corpus. Every result is LLM-generated and orbitally classified.

import { orbitalClassify, jsonResponse, corsHeaders } from './_orbital.js'

const MODEL = '@cf/meta/llama-3.1-8b-instruct'

const SYSTEM_PROMPT = `You are an AI agent skill author for a celestial-mechanics-style skill router. Given a user task, write polished, opinionated SKILL specifications — the kind a senior practitioner would commit into a curated corpus.

Each skill is a unit of expertise an AI agent can load. The body must be RICH and SPECIFIC, not generic. Match the depth of a mature open-source skill: concrete techniques, named tools, decision rules, and anti-patterns. Aim for 600–1200 chars of prose per body — the orbital classifier needs real signal to derive accurate physics scores (mass, scope, cross_domain, etc.).

Respond ONLY with a JSON object of this exact shape:
{
  "skills": [
    {
      "slug":        "kebab-case-slug",
      "description": "One sentence (≤30 words) — when to load this skill and what it covers, in concrete terms.",
      "keywords":    ["kw1", "kw2", ...],
      "body":        "Polished markdown skill body. Must include sections: '## Use It For' (3-6 bullets of concrete situations), '## Workflow' (numbered steps with concrete actions), '## Heuristics' (3-6 short rules of thumb), '## Anti-Patterns' (3-5 things to avoid). Be opinionated. Name specific tools, libraries, file paths, regex patterns, command-line flags. No hedging."
    }
  ]
}

Author guidelines:
- Slug: lowercase, kebab-case, alphanumeric + hyphens only.
- 10–14 keywords per skill: real terms that would appear in matching tasks (tool names, technique names, domain nouns and verbs). Mix common + specialised.
- 8 distinct skills covering: the core task, its prerequisites, 1–2 common variants, the most-used adjacent specialty, an anti-pattern / failure-mode skill, and a cross-domain bridge skill (one that touches another star system).
- Bodies must be PROPER markdown with real ## headings. No prose dumps. No platitudes. Treat the reader as an expert.
- Avoid near-duplicates. Each skill should defend its own slot.
- No prefatory text outside the JSON object. No \`\`\`fences.`

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const task       = (body.task || '').toString().trim()
  const limit      = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 5))
  const candidates = Math.max(4, Math.min(12, parseInt(body.candidates, 10) || 8))

  if (!task)             return jsonResponse({ error: 'task required'           }, { status: 400 })
  if (task.length > 800) return jsonResponse({ error: 'task too long (max 800)' }, { status: 400 })

  if (!env.AI) {
    return jsonResponse({ error: 'AI binding not configured on this deployment' }, { status: 503 })
  }

  // ── Phase 1: LLM generation
  let raw, aiLatencyMs = null
  try {
    const t0 = Date.now()
    raw = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Task: ${task}\n\nGenerate ${candidates} skills.` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object', required: ['skills'], additionalProperties: false,
          properties: {
            skills: {
              type: 'array', minItems: 4, maxItems: 12,
              items: {
                type: 'object',
                required: ['slug', 'description', 'keywords', 'body'],
                additionalProperties: false,
                properties: {
                  slug:        { type: 'string' },
                  description: { type: 'string' },
                  keywords:    { type: 'array', items: { type: 'string' } },
                  body:        { type: 'string' },
                },
              },
            },
          },
        },
      },
      max_tokens:  6000,
      temperature: 0.5,
    })
    aiLatencyMs = Date.now() - t0
  } catch (e) {
    return jsonResponse({ error: 'LLM call failed: ' + (e?.message || e) }, { status: 502 })
  }

  // ── Phase 2: parse + sanitize
  const generated = parseGenerated(raw)
  if (!generated.length) {
    return jsonResponse({
      error: 'LLM returned no usable skills',
      _debug: typeof raw === 'object' ? raw : { response_excerpt: String(raw).slice(0, 400) },
    }, { status: 502 })
  }

  // ── Phase 3: orbital classification + routing
  const classifyT0 = Date.now()
  const ranked = orbitalClassify(generated, task)
  const classifyMs = Date.now() - classifyT0

  const selected = ranked.slice(0, limit).map(s => ({
    ...s,
    source: 'dynamic',
  }))

  const top = selected[0]?.route_score || 0
  const confidence =
    top >= 80 ? 'strong' :
    top >= 30 ? 'moderate' :
    top >  0  ? 'weak' : 'none'

  return jsonResponse({
    task,
    note: 'Fully dynamic: skills generated by Llama-3.1-8b, classified by open-domain orbital engine (planet/moon/asteroid/trojan/comet/irregular).',
    confidence,
    top_score:        top,
    candidates_generated: generated.length,
    selected,
    timing: {
      llm_ms:        aiLatencyMs,
      classify_ms:   classifyMs,
      total_ms:      aiLatencyMs + classifyMs,
    },
  })
}

function parseGenerated(out) {
  let raw
  if (typeof out === 'string')                 raw = out
  else if (out && typeof out.response === 'string') raw = out.response
  else if (out && typeof out.response === 'object') raw = JSON.stringify(out.response)
  else                                         raw = JSON.stringify(out)

  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

  let parsed
  try { parsed = JSON.parse(raw) }
  catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    try { parsed = JSON.parse(m[0]) } catch { return [] }
  }

  const skills = Array.isArray(parsed) ? parsed
               : Array.isArray(parsed?.skills) ? parsed.skills
               : []

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
  return skills
    .filter(s => s && typeof s === 'object' && typeof s.slug === 'string')
    .map(s => ({
      slug:        s.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40),
      description: typeof s.description === 'string' ? s.description.slice(0, 280) : '',
      keywords:    Array.isArray(s.keywords)
                     ? s.keywords.map(k => String(k).toLowerCase().slice(0, 32)).filter(Boolean).slice(0, 16)
                     : [],
      body:        typeof s.body === 'string' ? s.body.slice(0, 2000) : '',
    }))
    .filter(s => SLUG_RE.test(s.slug))
}
