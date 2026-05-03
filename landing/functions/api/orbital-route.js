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
import { isOwnerIp } from './_ip.js'
import { validateAndTouch } from './stripe/_keys.js'
import { kvGet, kvPut, kvIncr, hasKV } from './_kv.js'
import { gatewayUrl, workersAiGatewayOpts } from './_ai-gateway.js'
import { sseResponse, iterOpenAIStream } from './_stream.js'
import { embedTexts, cosine, vectorizeUpsert, vectorizeQuery, hasEmbeddings, hasVectorize } from './_vector.js'

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

// Vision-lab 1-shot — same SKILL.md format as EXAMPLE_SKILL but biased
// toward immediate physical interaction. Used in place of EXAMPLE_SKILL
// when the request carries context: 'vision_lab' so the model anchors on
// hands-on/in-the-moment skill bodies instead of research-flavoured ones.
const VISION_LAB_EXAMPLE_SKILL = {
  slug: 'wooden-chair-stability-check',
  description: 'Diagnose whether a wooden chair is safe to sit on right now using only your hands, weight, and 30 seconds.',
  keywords: ['chair', 'stability', 'wobble-test', 'joint-inspection', 'in-place-test', 'load-bearing', 'tenon', 'glue-failure', 'wood-rot', 'physical-inspection', 'hands-on', 'safety-check'],
  body: `## Use It For

- Deciding in 30 seconds whether to sit on an unfamiliar wooden chair
- Spotting a failing joint before it collapses under load
- Triaging a wobbly chair as "tighten now" vs. "do not use"

## Workflow

1. With one hand on the seat front, push down and rock side-to-side — listen for ticking from the joints.
2. Lift the chair and twist the legs against each other; any rotation at the seat-leg junction means a failed tenon or dried glue.
3. Press a thumbnail into each leg near the floor — a soft mark means rot; reject the chair.
4. Sit slowly, hands on the seat edges, weight forward — if the back creaks or the rear legs splay, stand back up.

## Heuristics

- Loud single ticks under load = loose joint; slow whine = wood flex (usually fine).
- A chair that wobbles diagonally has a single bad joint; one that wobbles in all directions has multiple.
- White-glue squeeze-out at a joint is old and brittle — assume the joint is dead.

## Anti-Patterns

- Sitting first and "feeling for it" — the failure mode is the chair collapsing.
- Tightening visible screws without checking tenons; most chair failures are at glued mortise-and-tenon joints, not screws.
- Ignoring rear-leg splay because the chair "felt fine" empty.`,
}

// Bias paragraph appended to the user message when context === 'vision_lab'.
// Lives outside the system prompt so it can evolve per-context without
// rewriting the global rubric. Strong & specific — vague nudges get
// ignored by Llama-3.3-70B in favour of the system prompt's defaults.
const VISION_LAB_BIAS = `
CONTEXT: this task came from a person holding a phone camera, physically co-located with the subject RIGHT NOW. They are looking at it through the lens.

Strongly bias every skill toward IMMEDIATE PHYSICAL INTERACTION the person could perform within the next 60 seconds using:
- their hands, weight, voice, or body
- simple tools likely on hand (phone, pen, water, a coin, light source, the camera itself)
- the subject's own affordances (touch, lift, twist, press, listen, smell, look-from-different-angle)

PREFER skills like: hands-on inspection, quick safety/stability test, in-place quick fix, sensory diagnosis (touch/sound/smell), measurement with everyday tools, "what to do RIGHT NOW" decision rules, immediate-context triage.

AVOID skills that require: research time, library/database lookup, purchasing, historical context, extended workflows lasting >5 minutes, multi-day projects, anything the person could only do back at a desk.

The cross-domain bridge skill should still apply, but it too must be hands-on (e.g. a relevant first-aid skill if the subject is a person, a fire-safety skill if the subject is hot machinery).`

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
  } else if (hasKV(env)) {
    // Anonymous — soft per-IP per-day cap so the free tier is best-effort fair.
    const ip  = request.headers.get('cf-connecting-ip') || 'unknown'
    if (!isOwnerIp(ip, env)) {
      const dkey = `free:${ip}:${new Date().toISOString().slice(0, 10)}`
      const cur  = parseInt(await kvGet(env, dkey), 10) || 0
      if (cur >= FREE_TIER_DAILY_PER_IP) {
        return jsonResponse({
          error: `free tier exhausted (${FREE_TIER_DAILY_PER_IP} calls/day per IP). Upgrade to Pro for 10k/month — see ask-meridian.uk/#pricing`,
        }, { status: 429 })
      }
      await kvIncr(env, dkey, 90000)
    }
  }

  let body
  try { body = await request.json() }
  catch { return jsonResponse({ error: 'invalid JSON body' }, { status: 400 }) }

  const task       = (body.task || '').toString().trim()
  const limit      = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 5))
  const candidates = Math.max(3, Math.min(8, parseInt(body.candidates, 10) || 5))
  const provider   = ['workers-ai', 'groq'].includes(body.provider) ? body.provider : 'workers-ai'
  // Context modifies skill generation (e.g. vision_lab biases toward
  // immediate physical interaction). Default 'text' keeps existing
  // behaviour for typed tasks from the main miniapp + MCP clients.
  const context    = ['text', 'vision_lab'].includes(body.context) ? body.context : 'text'

  if (!task)             return jsonResponse({ error: 'task required'           }, { status: 400 })
  if (task.length > 800) return jsonResponse({ error: 'task too long (max 800)' }, { status: 400 })

  if (provider === 'workers-ai' && !env.AI) {
    return jsonResponse({ error: 'AI binding not configured on this deployment' }, { status: 503 })
  }
  if (provider === 'groq' && !env.GROQ_API_KEY) {
    return jsonResponse({ error: 'Groq not configured — bind GROQ_API_KEY' }, { status: 503 })
  }

  // Streaming vs JSON branch. Both call the same runPipeline() with a
  // different sink — see SINK_NOOP / makeStreamingSink below. Auth + quota
  // already gated above (we want clean 4xx JSON for those, not an SSE
  // error event). From here on we own the response.
  const url = new URL(request.url)
  const wantsStream =
    url.searchParams.get('stream') === '1' ||
    request.headers.get('accept')?.includes('text/event-stream')

  if (wantsStream) {
    const { response, send, close } = sseResponse()
    // Fire immediately so proxies don't time out the idle connection
    // before the LLM warms up.
    send('progress', { stage: 'connected', task, provider, context })
    ;(async () => {
      try {
        const result = await runPipeline({
          env, task, limit, candidates, provider, context, authResult,
          sink: makeStreamingSink(send),
        })
        await send('done', summaryOf(result))
      } catch (e) {
        await send('error', { message: e?.message || String(e) })
      } finally {
        await close()
      }
    })()
    return response
  }

  try {
    const result = await runPipeline({
      env, task, limit, candidates, provider, context, authResult,
      sink: SINK_NOOP,
    })
    const headers = {}
    if (authResult?.ok) {
      headers['x-meridian-plan']            = authResult.record.plan
      headers['x-meridian-calls-remaining'] = String(authResult.calls_remaining)
      headers['x-meridian-monthly-limit']   = String(authResult.record.monthly_limit)
    }
    if (result.cache_hit) headers['x-meridian-cache'] = 'hit'
    return jsonResponse(result, { headers })
  } catch (e) {
    const status = e?.status || 502
    return jsonResponse({ error: e?.message || String(e) }, { status })
  }
}

// ────────────────────────────────────────────────────────────────────────
// Single pipeline — used by both the JSON and SSE handlers. The sink
// decides whether progress and per-skill events go anywhere or get
// dropped on the floor; the pipeline itself is identical across modes.
//
// sink shape:
//   {
//     streamingEnabled: boolean,            // does the sink want LLM token stream?
//     onProgress(stage, details): void|Promise,
//     onSkill(skill):              void|Promise,
//   }
//
// Returns the full response payload (same shape the JSON handler returns
// directly; the SSE handler builds a `done` summary from it).
// ────────────────────────────────────────────────────────────────────────
async function runPipeline({ env, task, limit, candidates, provider, context, authResult, sink }) {
  const isVisionLab = context === 'vision_lab'
  const cacheKey = await sha256(`${task.toLowerCase().replace(/\s+/g, ' ').trim()}::${limit}::${candidates}::${context}`)

  // Phase 0: cache lookup.
  if (hasKV(env)) {
    const cached = await kvGet(env, `route:${cacheKey}`, 'json')
    if (cached) {
      const ageS = Math.floor((Date.now() - cached._cached_at) / 1000)
      await sink.onProgress('cache_hit', { cache_age_s: ageS })
      for (const skill of cached.selected || []) {
        await sink.onSkill(skill)
      }
      delete cached._cached_at
      cached.cache_hit  = true
      cached.cache_age_s = ageS
      if (authResult?.ok) {
        cached.quota = {
          plan:          authResult.record.plan,
          remaining:     authResult.calls_remaining,
          monthly_limit: authResult.record.monthly_limit,
        }
      }
      return cached
    }
  }
  await sink.onProgress('cache_miss', {})

  // Phase 0.5: embed the task once (used both for RAG retrieval below and
  // semantic re-rank below the LLM call). Saves a duplicate Workers AI
  // round-trip vs embedding the task separately in semanticRerank.
  let taskVec = null
  let ragMatches = []
  if (hasEmbeddings(env)) {
    const [v] = await embedTexts(env, [task])
    if (v) taskVec = v
  }

  // Phase 0.6: RAG — query Vectorize for similar past skills, inject as
  // an extra system message before the final user turn. Skips silently
  // when Vectorize is unbound, the index is empty, or no matches clear
  // the relevance threshold (cold-start safe).
  if (taskVec && hasVectorize(env)) {
    const matches = await vectorizeQuery(env, taskVec, 6)
    // Filter by score, dedupe slugs (multiple upserts of the same skill
    // are possible across days), keep top 3 distinct.
    const seen = new Set()
    ragMatches = matches
      .filter(m => (m.score || 0) >= 0.55)
      .filter(m => {
        const slug = m.metadata?.slug
        if (!slug || seen.has(slug)) return false
        seen.add(slug); return true
      })
      .slice(0, 3)
    if (ragMatches.length) {
      await sink.onProgress('rag_retrieved', {
        matches: ragMatches.length,
        top_score: Number((ragMatches[0].score || 0).toFixed(3)),
      })
    }
  }

  // Phase 1: build messages + call LLM.
  const messages = buildMessages({ task, candidates, isVisionLab, ragMatches })
  const llmStart = Date.now()
  let rawText
  try {
    if (provider === 'groq') {
      if (sink.streamingEnabled) {
        await sink.onProgress('llm_streaming_start', { model: 'llama-3.3-70b-versatile' })
        rawText = await callGroqStreaming(env, messages, async (chars, ms) => {
          await sink.onProgress('llm_streaming', { chars, ms })
        }, llmStart)
      } else {
        await sink.onProgress('llm_calling', { model: 'llama-3.3-70b-versatile' })
        rawText = await callGroqJSON(env, messages)
      }
    } else {
      await sink.onProgress('llm_calling', { model: MODEL.split('/').pop() })
      rawText = await callWorkersAI(env, messages)
    }
  } catch (e) {
    throw withStatus(`LLM call failed (${provider}): ${e?.message || e}`, 502)
  }
  const aiLatencyMs = Date.now() - llmStart
  await sink.onProgress('llm_complete', { chars: rawText.length, ms: aiLatencyMs })

  // Phase 2: parse + sanitize.
  const generated = parseGenerated({ response: rawText })
  if (!generated.length) {
    throw withStatus('LLM returned no usable skills', 502)
  }

  // Phase 3: orbital classify.
  await sink.onProgress('classifying', { candidates_generated: generated.length })
  const classifyT0 = Date.now()
  const ranked = orbitalClassify(generated, task)
  const classifyMs = Date.now() - classifyT0

  // Phase 3.5: semantic re-rank (best-effort, gated on env.AI).
  let embedMs = 0, reranked = ranked
  if (hasEmbeddings(env)) {
    await sink.onProgress('semantic_rerank', { model: 'bge-m3' })
    const t = Date.now()
    reranked = await semanticRerank(env, task, ranked, taskVec)
    embedMs  = Date.now() - t
  }

  const selected = reranked.slice(0, limit).map(s => ({ ...s, source: 'dynamic' }))

  // Phase 4: emit skills (sink-dependent — JSON sink no-ops, SSE sink
  // sends each one and pauses for visual rhythm).
  for (const skill of selected) {
    await sink.onSkill(skill)
  }

  const top = selected[0]?.route_score || 0
  const confidence =
    top >= 80 ? 'strong' :
    top >= 30 ? 'moderate' :
    top >  0  ? 'weak' : 'none'

  const modelLabel = provider === 'groq' ? 'llama-3.3-70b-versatile (Groq)' : `${MODEL.split('/').pop()} (Workers AI)`
  const responsePayload = {
    task, provider, context,
    model: modelLabel,
    note: `Fully dynamic: skills generated by ${modelLabel}, classified by the open-domain orbital engine (planet / moon / asteroid / trojan / comet / irregular).${isVisionLab ? ' Hands-on / physical-interaction bias applied (vision_lab context).' : ''}`,
    confidence,
    top_score:            top,
    candidates_generated: generated.length,
    selected,
    timing: {
      llm_ms:      aiLatencyMs,
      classify_ms: classifyMs,
      embed_ms:    embedMs,
      total_ms:    aiLatencyMs + classifyMs + embedMs,
    },
    cache_hit: false,
    quota: authResult?.ok ? {
      plan:          authResult.record.plan,
      remaining:     authResult.calls_remaining,
      monthly_limit: authResult.record.monthly_limit,
    } : null,
  }

  // Cache (strip request-specific quota — re-attached on hit).
  if (hasKV(env)) {
    const toCache = { ...responsePayload, _cached_at: Date.now() }
    delete toCache.quota
    await kvPut(env, `route:${cacheKey}`, toCache, 86400)
  }

  return responsePayload
}

// Build the prompt array used by both Groq + Workers AI calls. Optional
// ragMatches inject a SECOND system message after the main one with
// "previously generated similar skills" for inspiration only — the LLM
// is instructed to author fresh skills, not echo the past.
function buildMessages({ task, candidates, isVisionLab, ragMatches = [] }) {
  const exemplar = isVisionLab ? VISION_LAB_EXAMPLE_SKILL : EXAMPLE_SKILL
  const exemplarTaskHint = isVisionLab
    ? 'Task: someone is pointing their phone camera at a wooden chair.\n\nGenerate 1 skill, just to demonstrate the body format AND the hands-on, physically-immediate bias.'
    : `Task: build a source base for a person-specific voice model from public material.\n\nGenerate 1 skill, just to demonstrate the body format.`
  const finalUserMsg = `Task: ${task}\n\nGenerate ${candidates} skills covering the task and adjacent territory. Use the same depth as the example: real ## headings, concrete tools, named techniques, anti-patterns, opinionated heuristics. ${candidates >= 8 ? 'Include at least one cross-domain bridge skill (touches another star system).' : ''}${isVisionLab ? '\n' + VISION_LAB_BIAS : ''}`

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }]
  if (ragMatches.length) {
    const ctxLines = ragMatches
      .map(m => `- ${m.metadata?.slug || '?'}: ${m.metadata?.description || ''}${m.metadata?.class ? ` [${m.metadata.class}]` : ''}`)
      .join('\n')
    messages.push({
      role: 'system',
      content: `PRIOR-CONTEXT: this router has previously generated these related skills (semantic match against the current task). Use them ONLY as inspiration for slug-naming patterns, level of specificity, and depth of body — DO NOT echo their content. Author FRESH skills for the current task:\n\n${ctxLines}`,
    })
  }
  messages.push(
    { role: 'user',      content: exemplarTaskHint },
    { role: 'assistant', content: JSON.stringify({ skills: [exemplar] }) },
    { role: 'user',      content: finalUserMsg },
  )
  return messages
}

// Provider-specific LLM call helpers. All return a string of raw JSON
// suitable for parseGenerated({ response: rawText }).
async function callGroqJSON(env, messages) {
  const res = await fetch(gatewayUrl(env, 'groq', '/chat/completions'), {
    method: 'POST',
    headers: {
      authorization:  `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model:           'llama-3.3-70b-versatile',
      messages,
      response_format: { type: 'json_object' },
      temperature:     0.5,
      max_tokens:      3200,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || `Groq HTTP ${res.status}`)
  return data.choices?.[0]?.message?.content || ''
}

async function callGroqStreaming(env, messages, onChunk, llmStart) {
  const res = await fetch(gatewayUrl(env, 'groq', '/chat/completions'), {
    method: 'POST',
    headers: {
      authorization:  `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
      accept:         'text/event-stream',
    },
    body: JSON.stringify({
      model:           'llama-3.3-70b-versatile',
      messages,
      response_format: { type: 'json_object' },
      temperature:     0.5,
      max_tokens:      3200,
      stream:          true,
    }),
  })
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Groq HTTP ${res.status}: ${errBody.slice(0, 200)}`)
  }
  let raw = ''
  let lastSent = 0, lastChars = 0
  for await (const delta of iterOpenAIStream(res)) {
    raw += delta
    const now = Date.now()
    // Throttle: at most one chunk event per 250ms or per 600 chars.
    if (now - lastSent > 250 || raw.length - lastChars > 600) {
      await onChunk(raw.length, now - llmStart)
      lastSent  = now
      lastChars = raw.length
    }
  }
  return raw
}

async function callWorkersAI(env, messages) {
  const out = await env.AI.run(MODEL, {
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object', required: ['skills'], additionalProperties: false,
        properties: {
          skills: {
            type: 'array',
            // Cap at the requested count exactly so the model can't overshoot
            // and burn token budget. Floor at 3 so a request for 1 still yields
            // useful adjacent skills. Static bounds — Workers AI prefilters the
            // schema and a dynamic per-request shape was correlating with timeouts.
            minItems: 3, maxItems: 8,
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
  }, workersAiGatewayOpts(env))
  return typeof out === 'string'              ? out
       : typeof out?.response === 'string'    ? out.response
       : JSON.stringify(out?.response || out)
}

// Sink that swallows everything — JSON handler doesn't need progress events
// or per-skill streaming.
const SINK_NOOP = {
  streamingEnabled: false,
  onProgress: () => {},
  onSkill:    () => {},
}

// Sink for the SSE handler. Every progress/skill becomes a wire event;
// per-skill emission is paced for visual rhythm in the browser.
function makeStreamingSink(send) {
  return {
    streamingEnabled: true,
    onProgress: async (stage, details) => {
      await send('progress', { stage, ...details })
    },
    onSkill: async (skill) => {
      await send('skill', skill)
      await sleep(35)
    },
  }
}

// Tag an Error with an HTTP status code so the JSON handler can echo it.
function withStatus(message, status) {
  const e = new Error(message)
  e.status = status
  return e
}

// Build the SSE `done` event payload from the full pipeline result.
// Strips `selected` (those were already streamed individually) and keeps
// just the metadata.
function summaryOf(payload) {
  return {
    task:                 payload.task,
    provider:             payload.provider,
    context:              payload.context,
    model:                payload.model,
    confidence:           payload.confidence,
    top_score:            payload.top_score,
    candidates_generated: payload.candidates_generated,
    timing:               payload.timing,
    cache_hit:            Boolean(payload.cache_hit),
    quota:                payload.quota || null,
    note:                 payload.note,
  }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ────────────────────────────────────────────────────────────────────────
// Semantic re-rank.
//
// Embeds the user task + each ranked skill body via Workers AI bge-m3,
// computes cosine similarity per skill, and blends it into the orbital
// route_score with up to a 40% boost. Returns the ranked array re-sorted.
// Best-effort — any error returns the input unchanged.
//
// When env.VECTORIZE is bound, also fires off an upsert of (skill_id →
// embedding + metadata) so the index warms up for future RAG features.
// Upsert is fire-and-forget; we don't block the response on it.
// ────────────────────────────────────────────────────────────────────────
async function semanticRerank(env, task, ranked, preComputedTaskVec = null) {
  if (!hasEmbeddings(env) || !ranked?.length) return ranked
  try {
    let taskVec, skillVecs
    if (preComputedTaskVec) {
      // RAG retrieval already embedded the task — only embed the skill bodies.
      const skillTexts = ranked.map(s => `${s.description || ''}\n\n${s.body || ''}`.slice(0, 2000))
      skillVecs = await embedTexts(env, skillTexts)
      if (skillVecs.length !== ranked.length) return ranked
      taskVec = preComputedTaskVec
    } else {
      const inputs = [task, ...ranked.map(s => `${s.description || ''}\n\n${s.body || ''}`.slice(0, 2000))]
      const vectors = await embedTexts(env, inputs)
      if (vectors.length !== inputs.length) return ranked
      taskVec  = vectors[0]
      skillVecs = vectors.slice(1)
    }

    const enriched = ranked.map((s, i) => {
      const sim = cosine(taskVec, skillVecs[i])
      // Blend: orbital is the spine, semantic is a 0..40% multiplicative
      // boost. Keeps low-orbital-score skills from being floated by raw
      // semantic match (which would cause "looks similar" trojans to
      // outrank actually-useful planets).
      const semantic_score = Number(sim.toFixed(4))
      const blended = Number((s.route_score * (1 + 0.4 * sim)).toFixed(3))
      return { ...s, semantic_score, route_score_blended: blended }
    })

    // Fire-and-forget upsert into Vectorize (no-op when unbound).
    vectorizeUpsert(env, ranked.map((s, i) => ({
      id: s.slug,
      values: vectors[i + 1],
      metadata: {
        slug:        s.slug,
        description: (s.description || '').slice(0, 200),
        class:       s.classification?.class || '',
        star_system: s.classification?.star_system || '',
      },
    })))

    enriched.sort((a, b) => b.route_score_blended - a.route_score_blended)
    // Replace the visible route_score with the blended one so existing
    // clients (which sort by route_score) see the re-ranked order.
    return enriched.map(s => ({ ...s, route_score: s.route_score_blended }))
  } catch (e) {
    console.warn('[semantic-rerank] failed', e?.message)
    return ranked
  }
}
