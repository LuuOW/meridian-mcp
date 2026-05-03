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
