// POST /api/dynamic-route
// Body: { task: string, mode?: 'hybrid'|'dynamic-only'|'static-only', limit?: int }
//
// Asks Workers AI to generate plausible candidate skills for the task,
// then runs the lexical scorer over: (a) the static corpus, (b) the
// generated candidates, or (c) both — depending on `mode`. Returns one
// merged ranked list with `source: 'static'|'dynamic'` on each item.

import skillsIndex from '../../_skills.json'
import { scoreSkills, jsonResponse, corsHeaders } from './_router.js'

const MODEL = '@cf/meta/llama-3.1-8b-instruct'

const SYSTEM_PROMPT = `You are an AI agent skill curator. Given a user task, generate 8 plausible "skills" (knowledge units an AI agent could load) that would help with the task.

Respond ONLY with a JSON object of this exact shape:
{
  "skills": [
    {
      "slug": "kebab-case-slug",
      "description": "One concise sentence (≤25 words) describing what the skill covers and when to load it.",
      "keywords": ["keyword1", "keyword2", "..."]
    }
  ]
}

Rules:
- Slug must be lowercase, kebab-case, alphanumeric + hyphens only.
- 8–12 keywords per skill: nouns and verbs that would appear in a task description matching the skill.
- Skills must be distinct (no near-duplicates) and concrete (not generic).
- No markdown, no prose outside the JSON.`

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const task  = (body.task || '').toString().trim()
  const mode  = ['hybrid', 'dynamic-only', 'static-only'].includes(body.mode) ? body.mode : 'hybrid'
  const limit = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 5))

  if (!task)             return jsonResponse({ error: 'task required'           }, { status: 400 })
  if (task.length > 800) return jsonResponse({ error: 'task too long (max 800)' }, { status: 400 })

  // Static branch
  const staticRanked = mode === 'dynamic-only' ? [] : scoreSkills(task, skillsIndex.skills, skillsIndex.idf)
  staticRanked.forEach(s => { s.source = 'static' })

  // Dynamic branch — call Workers AI
  let dynamicRanked = []
  let dynamicError  = null
  let aiLatencyMs   = null

  if (mode !== 'static-only') {
    if (!env.AI) {
      dynamicError = 'AI binding not configured on this deployment'
    } else {
      try {
        const t0  = Date.now()
        const out = await env.AI.run(MODEL, {
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: `Task: ${task}` },
          ],
          response_format: {
            type:        'json_schema',
            json_schema: {
              type:                 'object',
              required:             ['skills'],
              additionalProperties: false,
              properties: {
                skills: {
                  type:     'array',
                  minItems: 1,
                  maxItems: 12,
                  items: {
                    type:                 'object',
                    required:             ['slug', 'description', 'keywords'],
                    additionalProperties: false,
                    properties: {
                      slug:        { type: 'string' },
                      description: { type: 'string' },
                      keywords:    { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          max_tokens:  800,
          temperature: 0.6,
        })
        aiLatencyMs = Date.now() - t0

        const generated = parseGenerated(out)
        // Score the generated candidates with the same scorer used on static.
        // We treat keywords as the description+body input to keep scoring consistent.
        const synthetic = generated.map(g => ({
          slug:        g.slug,
          name:        g.slug,
          description: g.description || '',
          orb_class:   null,
          keywords:    Array.isArray(g.keywords) ? g.keywords : [],
          body:        (g.description || '') + ' ' + (g.keywords || []).join(' '),
        }))
        dynamicRanked = scoreSkills(task, synthetic, skillsIndex.idf)
        dynamicRanked.forEach(s => { s.source = 'dynamic' })
      } catch (e) {
        dynamicError = String(e?.message || e)
      }
    }
  }

  // Merge — dedupe by slug (static wins on tie). Re-sort.
  const merged = []
  const seen   = new Set()
  for (const s of [...staticRanked, ...dynamicRanked]) {
    if (seen.has(s.slug)) continue
    seen.add(s.slug)
    merged.push(s)
  }
  merged.sort((a, b) => b.route_score - a.route_score)
  const selected = merged.slice(0, limit)

  const top = selected[0]?.route_score || 0
  const confidence =
    top >= 40 ? 'strong' :
    top >= 15 ? 'moderate' :
    top >  0  ? 'weak' : 'none'

  return jsonResponse({
    task,
    mode,
    note: 'Lexical scorer over static corpus + LLM-generated candidates. Workers AI: ' + MODEL,
    confidence,
    top_score:        top,
    static_count:     staticRanked.length,
    dynamic_count:    dynamicRanked.length,
    ai_latency_ms:    aiLatencyMs,
    dynamic_error:    dynamicError,
    selected,
  })
}

function parseGenerated(out) {
  // Workers AI returns { response: '...' } or sometimes the parsed value directly
  // depending on response_format support per model. Be defensive.
  let raw
  if (typeof out === 'string')                 raw = out
  else if (out && typeof out.response === 'string') raw = out.response
  else if (out && typeof out.response === 'object') raw = JSON.stringify(out.response)
  else                                         raw = JSON.stringify(out)

  // Strip markdown fences if the model snuck them in.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

  let parsed
  try { parsed = JSON.parse(raw) }
  catch {
    // Try to find the first {...} block.
    const m = raw.match(/\{[\s\S]*\}/)
    if (!m) return []
    try { parsed = JSON.parse(m[0]) } catch { return [] }
  }

  const skills = Array.isArray(parsed) ? parsed
               : Array.isArray(parsed?.skills) ? parsed.skills
               : []

  // Validate + sanitize each entry
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
  return skills
    .filter(s => s && typeof s === 'object' && typeof s.slug === 'string')
    .map(s => ({
      slug:        s.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40),
      description: typeof s.description === 'string' ? s.description.slice(0, 280) : '',
      keywords:    Array.isArray(s.keywords)
                     ? s.keywords.map(k => String(k).toLowerCase().slice(0, 32)).filter(Boolean).slice(0, 16)
                     : [],
    }))
    .filter(s => SLUG_RE.test(s.slug))
}
