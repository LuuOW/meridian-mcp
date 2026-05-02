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
import { validateAndTouch } from './stripe/_keys.js'

// Free tier: anonymous calls are allowed but capped to a soft daily limit
// per IP (best-effort — not the real auth boundary). Pro/Team keys lift that
// cap and bring monthly per-key quotas tracked in KV.
const FREE_TIER_DAILY_PER_IP = 5

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

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

// Compact 1-shot — short enough not to dominate prompt-token cost, dense
// enough that the model can imitate the structure (named sections,
// imperative tone, concrete tools).
const EXAMPLE_SKILL = {
  slug: 'persona-research',
  description: 'Build a source base for a person-specific voice model from public material — find, score, and de-noise authored sources.',
  keywords: ['persona', 'voice-model', 'biography', 'identity', 'transcript', 'youtube-watch-page', 'newsletter', 'podcast', 'self-authored', 'identity-collision'],
  body: `## Use It For

- Finding the right person across ambiguous search results
- Ranking public sources by usefulness for persona modeling
- Separating self-authored material from reviews and commentary

## Workflow

1. Seed: official site, YouTube channel, LinkedIn, newsletter URL.
2. Discover: search name alone, with domain terms, the official domain for bio/podcast, YouTube *watch* pages.
3. Score: official bio → self-authored newsletter → episode pages with transcripts → secondary profiles.
4. De-prioritise: wrong-person matches, widget-heavy embeds, testimonials.

## Heuristics

- Prefer first-person language over third-party praise.
- Prefer episode pages over playlists.
- Require an official-domain or self-authored anchor before accepting a cluster.

## Anti-Patterns

- Treating testimonials as identity evidence.
- Mixing same-named people into one source set.`,
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })
  if (request.method !== 'POST')    return jsonResponse({ error: 'POST only' }, { status: 405 })

  // ── Auth: optional Pro/Team API key ──────────────────────────────────
  // Anonymous calls succeed at free-tier rates (best-effort IP cap).
  // Bearer mrd_live_… keys validate against KV and return quota headers.
  const authHeader = request.headers.get('authorization') || ''
  let authResult = null
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim()
    if (env.MERIDIAN_KEYS) {
      authResult = await validateAndTouch(env, token)
      if (!authResult.ok) {
        return jsonResponse({ error: authResult.error }, { status: authResult.code })
      }
    }
  } else if (env.MERIDIAN_KEYS) {
    // Anonymous — soft per-IP per-day cap so the free tier is best-effort fair.
    const ip  = request.headers.get('cf-connecting-ip') || 'unknown'
    const ownerSet = new Set((env.OWNER_IPS || '').split(',').map(s => s.trim()).filter(Boolean))
    if (!ownerSet.has(ip)) {
      const dkey = `free:${ip}:${new Date().toISOString().slice(0, 10)}`
      const cur  = parseInt(await env.MERIDIAN_KEYS.get(dkey), 10) || 0
      if (cur >= FREE_TIER_DAILY_PER_IP) {
        return jsonResponse({
          error: `free tier exhausted (${FREE_TIER_DAILY_PER_IP} calls/day per IP). Upgrade to Pro for 10k/month — see ask-meridian.uk/#pricing`,
        }, { status: 429 })
      }
      await env.MERIDIAN_KEYS.put(dkey, String(cur + 1), { expirationTtl: 90000 })
    }
  }

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const task       = (body.task || '').toString().trim()
  const limit      = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 5))
  const candidates = Math.max(3, Math.min(8, parseInt(body.candidates, 10) || 5))
  const provider   = ['workers-ai', 'groq'].includes(body.provider) ? body.provider : 'workers-ai'

  if (!task)             return jsonResponse({ error: 'task required'           }, { status: 400 })
  if (task.length > 800) return jsonResponse({ error: 'task too long (max 800)' }, { status: 400 })

  if (provider === 'workers-ai' && !env.AI) {
    return jsonResponse({ error: 'AI binding not configured on this deployment' }, { status: 503 })
  }
  if (provider === 'groq' && !env.GROQ_API_KEY) {
    return jsonResponse({ error: 'Groq not configured — bind GROQ_API_KEY' }, { status: 503 })
  }

  // ── Phase 0: cache lookup. Same task in the last 24 h → cached response.
  // Saves ~30s + ~200 neurons per repeat. Keyed by SHA-256 of the normalised
  // task text. Anonymous calls share the cache; per-user quotas still apply
  // when a key is presented (we only skip the LLM, not the auth gate).
  const cacheKey = await sha256(`${task.toLowerCase().replace(/\s+/g, ' ').trim()}::${limit}::${candidates}`)
  if (env.MERIDIAN_KEYS) {
    const cached = await env.MERIDIAN_KEYS.get(`route:${cacheKey}`, 'json')
    if (cached) {
      cached.cache_hit  = true
      cached.cache_age_s = Math.floor((Date.now() - cached._cached_at) / 1000)
      delete cached._cached_at
      // Still attach quota info if the user is paid
      if (authResult?.ok) {
        cached.quota = {
          plan: authResult.record.plan,
          remaining: authResult.calls_remaining,
          monthly_limit: authResult.record.monthly_limit,
        }
      }
      return jsonResponse(cached, { headers: authResult?.ok ? {
        'x-meridian-plan':            authResult.record.plan,
        'x-meridian-calls-remaining': String(authResult.calls_remaining),
        'x-meridian-cache':           'hit',
      } : { 'x-meridian-cache': 'hit' }})
    }
  }

  // ── Phase 1: LLM generation
  let raw, aiLatencyMs = null
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Task: build a source base for a person-specific voice model from public material.\n\nGenerate 1 skill, just to demonstrate the body format.` },
    { role: 'assistant', content: JSON.stringify({ skills: [EXAMPLE_SKILL] }) },
    { role: 'user',   content: `Task: ${task}\n\nGenerate ${candidates} skills covering the task and adjacent territory. Use the same depth as the persona-research example: real ## headings, concrete tools, named techniques, anti-patterns, opinionated heuristics. ${candidates >= 8 ? 'Include at least one cross-domain bridge skill (touches another star system).' : ''}` },
  ]
  try {
    const t0 = Date.now()
    if (provider === 'groq') {
      // Groq OpenAI-compatible /chat/completions — Llama-3.3-70B at ~300 tok/s
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization:  `Bearer ${env.GROQ_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:        'llama-3.3-70b-versatile',
          messages,
          response_format: { type: 'json_object' },
          temperature:  0.5,
          max_tokens:   3200,
        }),
      })
      const groqData = await groqRes.json()
      if (!groqRes.ok) throw new Error(groqData.error?.message || `Groq HTTP ${groqRes.status}`)
      raw = { response: groqData.choices?.[0]?.message?.content || '' }
    } else {
      raw = await env.AI.run(MODEL, {
        messages,
        response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object', required: ['skills'], additionalProperties: false,
          properties: {
            skills: {
              type: 'array',
              // Cap at the requested count exactly so the model can't
              // overshoot and burn token budget. Floor at 3 so a request
              // for 1 still yields useful adjacent skills.
              // Static bounds — Workers AI prefilters the schema and a
              // dynamic per-request shape was correlating with timeouts.
              minItems: 3,
              maxItems: 8,
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
      max_tokens:  3200,
      temperature: 0.5,
    })
    }   // end workers-ai branch
    aiLatencyMs = Date.now() - t0
  } catch (e) {
    return jsonResponse({ error: `LLM call failed (${provider}): ` + (e?.message || e) }, { status: 502 })
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

  const headers = {}
  if (authResult?.ok) {
    headers['x-meridian-plan']            = authResult.record.plan
    headers['x-meridian-calls-remaining'] = String(authResult.calls_remaining)
    headers['x-meridian-monthly-limit']   = String(authResult.record.monthly_limit)
  }

  const modelLabel = provider === 'groq' ? 'llama-3.3-70b-versatile (Groq)' : `${MODEL.split('/').pop()} (Workers AI)`
  const responsePayload = {
    task,
    provider,
    model: modelLabel,
    note: `Fully dynamic: skills generated by ${modelLabel}, classified by the open-domain orbital engine (planet / moon / asteroid / trojan / comet / irregular).`,
    confidence,
    top_score:        top,
    candidates_generated: generated.length,
    selected,
    timing: {
      llm_ms:        aiLatencyMs,
      classify_ms:   classifyMs,
      total_ms:      aiLatencyMs + classifyMs,
    },
    cache_hit: false,
    quota: authResult?.ok ? {
      plan:          authResult.record.plan,
      remaining:     authResult.calls_remaining,
      monthly_limit: authResult.record.monthly_limit,
    } : null,
  }

  // Stash in cache (24 h TTL). Strip request-specific quota — re-attached on hit.
  if (env.MERIDIAN_KEYS) {
    const toCache = { ...responsePayload, _cached_at: Date.now() }
    delete toCache.quota
    await env.MERIDIAN_KEYS.put(`route:${cacheKey}`, JSON.stringify(toCache), { expirationTtl: 86400 })
  }

  return jsonResponse(responsePayload, { headers })
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
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
