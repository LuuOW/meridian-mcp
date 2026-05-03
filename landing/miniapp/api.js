// Shared client for /api/orbital-route. Used by the main miniapp (app.js)
// and the vision lab (vision-lab/lab.js) so the request shape stays
// consistent across both surfaces — if the API gains a required field,
// only this file changes.

export async function routeTask({ task, limit = 5, provider = 'workers-ai', context = 'text' }) {
  const res = await fetch('/api/orbital-route', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ task, limit, provider, context }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// Streaming variant. Calls /api/orbital-route?stream=1 and invokes the
// provided callbacks as events arrive. Returns a Promise that resolves on
// the `done` event (with the summary payload) or rejects on `error`.
//
// callbacks:
//   onProgress(detail)  — fires for each `event: progress` (stage + details)
//   onSkill(skill)      — fires for each ranked skill, in order
//
// Use the same shape as routeTask for the request body so callers can
// switch streaming on/off without rewiring anything.
export async function routeTaskStream(
  { task, limit = 5, provider = 'workers-ai', context = 'text' },
  { onProgress = () => {}, onSkill = () => {} } = {},
) {
  const res = await fetch('/api/orbital-route?stream=1', {
    method:  'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body:    JSON.stringify({ task, limit, provider, context }),
  })
  if (!res.ok) {
    // The server returns plain JSON 4xx/5xx for auth/quota errors before
    // promoting to SSE — handle those uniformly with the non-stream path.
    let data; try { data = await res.json() } catch {}
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  if (!res.body) throw new Error('streaming not supported by this browser')

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let summary = null
  let errMsg = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const msg = buf.slice(0, idx)
      buf = buf.slice(idx + 2)

      let event = 'message'
      const dataLines = []
      for (const line of msg.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      let payload
      try { payload = JSON.parse(dataLines.join('\n')) }
      catch { continue }

      if (event === 'progress') onProgress(payload)
      else if (event === 'skill') onSkill(payload)
      else if (event === 'done')  summary = payload
      else if (event === 'error') errMsg  = payload?.message || 'unknown error'
    }
  }
  if (errMsg) throw new Error(errMsg)
  return summary
}
