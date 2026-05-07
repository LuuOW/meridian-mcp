// Skill router client. Used by miniapp/app.js and vision-lab/lab.js.
//
// Routes through the live Meridian MCP at mcp.ask-meridian.uk via its
// first-party browser endpoint (POST /v1/route). The endpoint is
// operator-paid (the GitHub PAT lives in a Cloudflare Worker secret),
// Origin-allowlisted (ask-meridian.uk + sub-properties), and returns
// the full classifier output.
//
// History note: an earlier path ran a local browser-side classifier
// against a static _skills.json corpus (./_lib/router.mjs). That copy
// drifted from the LLM-generated candidates the server produces and
// has been removed.
//
// Signatures (routeTask, routeTaskStream) preserved so callers don't
// change. The streaming variant fakes its progress stages — the MCP
// returns the full result in one POST, but consumers expect a
// connected → llm_calling → classifying → done sequence so the UI
// doesn't freeze for 5–15 s.

const ROUTE_ENDPOINT = 'https://mcp.ask-meridian.uk/v1/route'
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
  // selected, timing }. Callers expect `skills` (legacy from the local
  // router shape) so we alias it here without losing any fields.
  return {
    ...body,
    skills: body.selected || [],
  }
}

export async function routeTask({ task, limit = 5, signal } = {}) {
  if (!task) throw new Error('task required')
  return postRoute(task, limit, signal)
}

// Streaming variant. The MCP returns the full result in a single POST,
// but the UI consumers expect a sequence of progress stages so the
// "5–15 s of nothing" feels alive. Fire synthetic progress stages
// before the request returns, then per-skill onSkill callbacks once
// the result lands.
export async function routeTaskStream(
  { task, limit = 5, signal } = {},
  { onProgress = () => {}, onSkill = () => {} } = {},
) {
  onProgress({ stage: 'connected' })
  onProgress({ stage: 'llm_calling', model: 'meta/llama-3.3-70b-instruct' })

  const result = await postRoute(task, limit, signal)

  if (result.candidates_generated) {
    onProgress({ stage: 'classifying', candidates_generated: result.candidates_generated })
  }
  for (const s of result.skills) onSkill(s)
  onProgress({ stage: 'done', count: result.skills.length })
  return result
}
