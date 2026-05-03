// Embeddings + (optional) Vectorize wrapper.
//
// Two layers:
//   1. embedTexts(env, texts) — calls Workers AI bge-m3 to get 1024-d
//      embeddings. Used in-process for semantic re-ranking; no persistence.
//   2. vectorizeUpsert / vectorizeQuery — talks to a Cloudflare Vectorize
//      index when env.VECTORIZE is bound. Both are no-ops when unbound, so
//      callers can fire-and-forget without env-checking.
//
// Setup for Vectorize (one-time, out of band):
//   wrangler vectorize create meridian-skills --dimensions=1024 --metric=cosine
//   then in wrangler.toml or the Pages bindings UI:
//     [[vectorize]]
//     binding   = "VECTORIZE"
//     index_name = "meridian-skills"
//
// The semantic re-rank works without Vectorize — it only needs env.AI.

const EMBEDDING_MODEL = '@cf/baai/bge-m3'

export function hasEmbeddings(env) {
  return Boolean(env?.AI)
}

export function hasVectorize(env) {
  return Boolean(env?.VECTORIZE)
}

// Returns an array of Float32Array vectors, one per input string. Returns
// [] when env.AI is unavailable so callers can branch cleanly.
export async function embedTexts(env, texts) {
  if (!hasEmbeddings(env) || !texts?.length) return []
  // bge-m3 accepts up to 100 inputs in a single call. Skill bodies are
  // capped at 2000 chars in parseGenerated so we're well under the per-input
  // token budget.
  const out = await env.AI.run(EMBEDDING_MODEL, { text: texts })
  // Workers AI returns { data: [[...], [...]], shape: [N, 1024] }
  return Array.isArray(out?.data) ? out.data.map(v => new Float32Array(v)) : []
}

// Cosine similarity. Inputs are typed-arrays of equal length.
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom ? dot / denom : 0
}

// Fire-and-forget upsert. Each item: { id, values, metadata }.
// Returns null when Vectorize isn't bound; doesn't throw.
export async function vectorizeUpsert(env, items) {
  if (!hasVectorize(env) || !items?.length) return null
  try {
    return await env.VECTORIZE.upsert(items.map(it => ({
      id:       String(it.id),
      values:   it.values instanceof Float32Array ? Array.from(it.values) : it.values,
      metadata: it.metadata || {},
    })))
  } catch (e) {
    console.warn('[vectorize] upsert failed', e?.message)
    return null
  }
}

// Query the Vectorize index for the top-K nearest neighbours to `vector`.
// Returns [] when Vectorize isn't bound or on error.
export async function vectorizeQuery(env, vector, topK = 10) {
  if (!hasVectorize(env)) return []
  try {
    const res = await env.VECTORIZE.query(
      vector instanceof Float32Array ? Array.from(vector) : vector,
      { topK, returnMetadata: true },
    )
    return res?.matches || []
  } catch (e) {
    console.warn('[vectorize] query failed', e?.message)
    return []
  }
}
