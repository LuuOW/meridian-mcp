// Meridian router client. Used by miniapp/app.js and vision-lab/lab.js.
//
// Routes through the live Meridian MCP at mcp.ask-meridian.uk via its
// first-party browser endpoint (POST /v1/route). The endpoint is
// operator-paid (the GitHub PAT lives in a Cloudflare Worker secret),
// Origin-allowlisted (ask-meridian.uk + sub-properties), and returns
// the full classifier output.
//
// History note: an earlier path ran a local browser-side classifier
// against a static _candidates.json corpus (./_lib/router.mjs). That
// copy drifted from the LLM-generated candidates the server produces
// and has been removed.
//
// Signatures (routeTask, routeTaskStream) preserved so callers don't
// change. The streaming variant fakes its progress stages — the MCP
// returns the full result in one POST, but consumers expect a
// connected → llm_calling → classifying → done sequence so the UI
// doesn't freeze for 5–15 s.

const ROUTE_ENDPOINT    = 'https://mcp.ask-meridian.uk/v1/route'
const FEEDBACK_ENDPOINT = 'https://mcp.ask-meridian.uk/v1/feedback'
const TIMEOUT_MS = 60_000

async function postRoute(task, limit, signal) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener?.('abort', onAbort)

  let res
  try {
    res = await fetch(ROUTE_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ task: String(task).slice(0, 800), limit }),
      signal:  ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Meridian MCP HTTP ${res.status}`)

  // Server returns { task, confidence, top_score, candidates_generated,
  // selected, timing }. Expose as `candidates` for callers; keep the
  // legacy `skills` alias for backwards compatibility with old front-ends.
  const candidates = body.selected || []
  return { ...body, candidates, skills: candidates }
}

export async function routeTask({ task, limit = 5, signal } = {}) {
  if (!task) throw new Error('task required')
  return postRoute(task, limit, signal)
}

// Streaming variant. The MCP returns the full result in a single POST,
// but the UI consumers expect a sequence of progress stages so the
// "5–15 s of nothing" feels alive. Fire synthetic progress stages
// before the request returns, then per-candidate onCandidate callbacks
// once the result lands.
export async function routeTaskStream(
  { task, limit = 5, signal } = {},
  { onProgress = () => {}, onCandidate, onSkill } = {},
) {
  // Back-compat: older callers pass `onSkill`. Honour both.
  const cb = onCandidate || onSkill || (() => {})
  onProgress({ stage: 'connected' })
  onProgress({ stage: 'llm_calling', model: 'meta/llama-3.3-70b-instruct' })

  const result = await postRoute(task, limit, signal)

  if (result.candidates_generated) {
    onProgress({ stage: 'classifying', candidates_generated: result.candidates_generated })
  }
  for (const s of result.candidates) cb(s)
  onProgress({ stage: 'done', count: result.candidates.length })
  return result
}

// Fire-and-forget /v1/feedback POST. The worker uses these to drive
// online SGD on top of the orbital classifier — every candidate the
// user engages with is one pairwise-ranking step. Never throws or
// blocks the UI; failures log at warn level.
export function sendFeedback({ task, candidates, skills, chosenSlug, action = 'click' }) {
  // Back-compat: older callers pass `skills`.
  const list = candidates || skills
  if (!task || !Array.isArray(list) || !chosenSlug) return
  try {
    fetch(FEEDBACK_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({
        query:        task,
        // Worker schema is `selected` (matches /v1/route output).
        selected:     list,
        chosen_slug:  chosenSlug,
        action,
      }),
      keepalive: true,
    }).catch(e => console.warn('[meridian] feedback failed:', e?.message || e))
  } catch (e) {
    console.warn('[meridian] feedback fire failed:', e?.message || e)
  }
}
