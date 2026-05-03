// SSE helpers shared between any handler that wants to stream pipeline
// progress to the browser. Wire-compatible with EventSource and with the
// fetch+ReadableStream consumer in /miniapp/api.js.
//
// Event types we emit from /api/orbital-route?stream=1:
//   event: progress  data: {stage: "...", ...details}
//   event: skill     data: {...full classified skill...}     (one per skill, ranked)
//   event: done      data: {summary fields like task/timing/confidence/...}
//   event: error     data: {message}

const enc = new TextEncoder()

export function sseResponse() {
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const send = async (event, data) => {
    try {
      // Each SSE message: optional `event: name`, then `data: <json>`,
      // terminated by a blank line. JSON-encode so newlines in the payload
      // don't break the framing.
      await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    } catch {
      // Writer closed (client disconnected). Swallow — caller can detect
      // by catching the next send() or just keep going.
    }
  }

  const close = async () => {
    try { await writer.close() } catch {}
  }

  const response = new Response(readable, {
    headers: {
      'content-type':              'text/event-stream; charset=utf-8',
      'cache-control':             'no-cache, no-transform',
      'x-accel-buffering':         'no',           // hint for proxies that strip SSE buffering
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
    },
  })

  return { response, send, close }
}

// Parse a Groq/OpenAI-style SSE chunk stream into incremental content
// deltas. Each chunk in the stream is a "data: {...}\n\n" block; the
// terminator chunk is "data: [DONE]\n\n". Yields strings of content
// deltas as they arrive. Caller accumulates into a buffer.
export async function* iterOpenAIStream(response) {
  if (!response.body) return
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    // SSE messages are blank-line-delimited. Split off completed messages
    // and keep any partial trailing one for the next iteration.
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const msg = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      // Each SSE message can have multiple `data:` lines; concatenate them.
      const dataLines = msg.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
      if (!dataLines.length) continue
      const payload = dataLines.join('\n')
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload)
        const delta = parsed?.choices?.[0]?.delta?.content || ''
        if (delta) yield delta
      } catch {
        // Skip malformed chunks rather than aborting the whole stream
      }
    }
  }
}
