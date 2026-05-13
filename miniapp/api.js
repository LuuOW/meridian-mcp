// Meridian router client — routes through the live MCP at
// mcp.ask-meridian.uk via /v1/route (cf-worker → GH Models).
//
// Origin-restricted server-side to *.ask-meridian.uk hosts; the worker
// holds the GitHub PAT so the browser never carries credentials.

const ROUTE_ENDPOINT    = 'https://mcp.ask-meridian.uk/v1/route'
const FEEDBACK_ENDPOINT = 'https://mcp.ask-meridian.uk/v1/feedback'
const TIMEOUT_MS = 60_000

async function postRoute(task, limit, signal) {
  const ctrl  = new AbortController()
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

  const candidates = body.selected || []
  return { ...body, candidates, skills: candidates }
}

export async function routeTask(task, { limit = 5, signal } = {}) {
  return postRoute(task, limit, signal)
}

// Streaming variant. The MCP returns the full result in one POST, but
// consumers expect a connected → llm_calling → classifying → done
// sequence so the UI shows progress instead of a 3–5 s freeze.
export async function routeTaskStream(task, { limit = 5, signal, onProgress } = {}) {
  onProgress?.({ stage: 'connected' })
  onProgress?.({ stage: 'llm_calling', model: 'llama-3.3-70b' })
  const result = await postRoute(task, limit, signal)
  onProgress?.({ stage: 'classifying', n: result.candidates_generated })
  onProgress?.({ stage: 'done', confidence: result.confidence, top_score: result.top_score })
  return result
}

export async function sendFeedback(eventType, payload) {
  try {
    await fetch(FEEDBACK_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ event_type: eventType, ...payload }),
      keepalive: true,
    })
  } catch (e) {
    console.warn('feedback POST failed:', e)
  }
}
