// Online learning layer for the orbital classifier.
//
// Architecture
// ────────────
// On every /v1/feedback POST, the Worker:
//   1. Pulls a small fitted-weights JSON from KV (~24 floats).
//   2. Extracts a 24-dim feature vector for every candidate in
//      the feedback batch.
//   3. Runs one pairwise-ranking SGD step against the chosen candidate
//      vs each non-chosen candidate (RankNet/RankSVM-style).
//   4. Writes the updated weights back.
//
// On every /v1/route, the Worker:
//   1. Computes the same feature vector per candidate.
//   2. Multiplies route_score by `1 + tanh(w · x)` so the heuristic
//      v2 ranking is the cold-start base and the fitted correction is
//      bounded to [0, 2] — protects against runaway updates.
//
// Constant-time per request, no batch training, no GPU.
//
// Compatibility note: bumping FEATURE_VERSION invalidates stored
// weights. Old weights would be misaligned with the new feature
// vector, so we re-init from zeros on version mismatch.

// v2 (2026-05-09): added f[24] = coherence_time (B1, Loudon Ch 3.1
// g^(1) autocorrelation). 2× more discriminative than the 3-bin
// cross_domain Shannon-entropy proxy; verified on photon-route sim_b1.
// Bumping invalidates v1 stored weights — they re-init on next update.
export const FEATURE_VERSION = 'v2'
export const FEATURE_DIM = 25

// Hyper-parameters. Conservative — small per-event nudge, light
// L2 to prevent runaway, tanh squashing on the output already
// bounds per-candidate correction.
const LR     = 0.02     // learning rate
const L2     = 0.001    // L2 regularization coefficient
const TANH_K = 0.6      // applied to dot product before tanh, so the
                        // multiplier 1 + tanh(K · w·x) only saturates at
                        // |w·x| > 2 (room for fitted weights to grow).

// ─── Feature extraction ───────────────────────────────────────────
// 25 features per candidate. Order is load-bearing: changing it requires
// bumping FEATURE_VERSION and zeroing stored weights.
//
//   [0..7]    physics scalars (mass, scope, indep, cross_domain,
//             fragmentation, drag, dep_ratio, lagrange_potential)
//   [8..13]   class one-hot (planet, moon, trojan, asteroid, comet, irregular)
//   [14..16]  star-system one-hot (forge, signal, mind)
//   [17..19]  token-hit features (kw_hits/5, desc_hits/5, body_hits/10) — clamped
//   [20]      route_score normalised by batch max
//   [21]      rank position normalised (0=top, 1=bottom)
//   [22]      has_parent (0/1)
//   [23]      habitable_zone (0/1)
//   [24]      coherence_time / 4 — clamped to [0,1] (B1, see physicsOf)
const CLASS_INDEX  = { planet: 0, moon: 1, trojan: 2, asteroid: 3, comet: 4, irregular: 5 }
const SYSTEM_INDEX = { forge: 0, signal: 1, mind: 2 }

function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }

export function extractFeaturesBatch(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const maxScore = Math.max(0.0001, ...candidates.map(s => +s.route_score || 0))
  return candidates.map((s, i) => {
    const f = new Float64Array(FEATURE_DIM)
    const phys = s?.classification?.physics || {}
    f[0] = clamp(+phys.mass         || 0)
    f[1] = clamp(+phys.scope        || 0)
    f[2] = clamp(+phys.independence || 0)
    f[3] = clamp(+phys.cross_domain || 0)
    f[4] = clamp(+phys.fragmentation|| 0)
    f[5] = clamp(+phys.drag         || 0)
    f[6] = clamp(+phys.dep_ratio    || 0)
    f[7] = clamp(+phys.lagrange_potential || 0)

    const cls = s?.classification?.class || ''
    if (CLASS_INDEX[cls] !== undefined) f[8 + CLASS_INDEX[cls]] = 1

    const sys = s?.classification?.star_system || ''
    if (SYSTEM_INDEX[sys] !== undefined) f[14 + SYSTEM_INDEX[sys]] = 1

    const bd = s?.breakdown || {}
    f[17] = clamp((+bd.kw_hits   || 0) / 5)
    f[18] = clamp((+bd.desc_hits || 0) / 5)
    f[19] = clamp((+bd.body_hits || 0) / 10)

    f[20] = clamp((+s.route_score || 0) / maxScore)
    f[21] = clamp(i / Math.max(1, candidates.length - 1))
    f[22] = s?.classification?.parent ? 1 : 0
    f[23] = s?.classification?.habitable_zone ? 1 : 0
    f[24] = clamp((+phys.coherence_time || 0) / 4)   // τ_c ∈ [0, ~3], normalise to [0,1]
    return f
  })
}

// ─── Inference (apply correction to route_score) ──────────────────
function dot(w, x) {
  let s = 0
  for (let i = 0; i < FEATURE_DIM; i++) s += w[i] * x[i]
  return s
}

export function applyFittedCorrection(candidates, weights) {
  if (!weights || !weights.w) return candidates      // no model yet → heuristic only
  const features = extractFeaturesBatch(candidates)
  return candidates.map((s, i) => {
    const score = dot(weights.w, features[i])
    const multiplier = 1 + Math.tanh(TANH_K * score)
    const newScore = (+s.route_score || 0) * multiplier
    return { ...s, route_score: Number(newScore.toFixed(3)),
                   _fitted: { multiplier: +multiplier.toFixed(3),
                              raw_correction: +score.toFixed(3) } }
  }).sort((a, b) => b.route_score - a.route_score)
}

// ─── Online SGD update (pairwise ranking) ─────────────────────────
// For each (chosen, other) pair: maximise margin = w·(x_chosen − x_other).
// Logistic ranking loss, gradient = -(1 − σ(margin)) · (x_chosen − x_other).
// Plus L2 shrinkage.
function sigmoid(x) {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z) }
  const z = Math.exp(x); return z / (1 + z)
}

export function sgdUpdate(weights, candidates, chosenIndex, opts = {}) {
  const lr = opts.lr ?? LR
  const l2 = opts.l2 ?? L2

  const w = weights?.w && weights.w.length === FEATURE_DIM
    ? Float64Array.from(weights.w)
    : new Float64Array(FEATURE_DIM)
  const features = extractFeaturesBatch(candidates)
  const xPos = features[chosenIndex]
  if (!xPos) return { w: Array.from(w), n_updates: weights?.n_updates ?? 0, version: FEATURE_VERSION }

  let pairsApplied = 0
  for (let j = 0; j < features.length; j++) {
    if (j === chosenIndex) continue
    const xNeg = features[j]
    // margin = w · (xPos − xNeg)
    let margin = 0
    for (let k = 0; k < FEATURE_DIM; k++) margin += w[k] * (xPos[k] - xNeg[k])
    const grad = (1 - sigmoid(margin))   // pull chosen up if margin small
    if (grad <= 0) continue
    for (let k = 0; k < FEATURE_DIM; k++) {
      w[k] += lr * grad * (xPos[k] - xNeg[k])
    }
    pairsApplied++
  }
  // L2 shrinkage (applied once per event, not per pair, to keep updates bounded).
  for (let k = 0; k < FEATURE_DIM; k++) w[k] *= (1 - lr * l2)

  return {
    w: Array.from(w),
    n_updates: (weights?.n_updates ?? 0) + 1,
    n_pairs: (weights?.n_pairs ?? 0) + pairsApplied,
    version: FEATURE_VERSION,
    updated_at: new Date().toISOString(),
  }
}

// ─── KV helpers ────────────────────────────────────────────────────
const KV_KEY_WEIGHTS = 'weights:v1'

export async function loadWeights(kv) {
  try {
    const raw = await kv.get(KV_KEY_WEIGHTS, 'json')
    if (!raw) return null
    if (raw.version !== FEATURE_VERSION) return null   // stale; will be re-initialised on next update
    if (!Array.isArray(raw.w) || raw.w.length !== FEATURE_DIM) return null
    return raw
  } catch { return null }
}

export async function saveWeights(kv, weights) {
  try {
    await kv.put(KV_KEY_WEIGHTS, JSON.stringify(weights))
    return true
  } catch { return false }
}

export const _internal = { dot, sigmoid, KV_KEY_WEIGHTS }
