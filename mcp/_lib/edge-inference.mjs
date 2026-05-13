// Browser-model loaders backed by @huggingface/transformers.
//
// Extracted and generalized from lens/src/vlm.mjs. One loader per slot
// in MODELS (vision / llm / protein). All share:
//
//   • Cache Storage pinned by sw-models.mjs (sw must be registered before
//     the first load() — otherwise the first download goes uncached).
//   • IDB-pinned version: bumping MODELS[slot].version evicts the slot's
//     cache entries on next load() so old weights don't linger.
//   • Concurrent-call de-dup: every loader memoizes its in-flight promise
//     so a refresh during load doesn't trigger a double download.
//   • WebGPU preferred, WASM fallback. transformers.js picks dtype
//     accordingly (fp16 GPU / q4 CPU).
//
// Apps call requestPersistentStorage() once on a user gesture so the
// browser doesn't evict the cached weights under disk pressure.

import {
  env,
  AutoProcessor, AutoTokenizer,
  AutoModelForVision2Seq, AutoModelForCausalLM, AutoModel,
} from '@huggingface/transformers'

import { MODELS } from './models.mjs'

env.allowLocalModels = false
env.useBrowserCache  = true

const AUTO_CLASSES = {
  AutoModelForVision2Seq,
  AutoModelForCausalLM,
  AutoModel,
}

// ── IDB version pin ──────────────────────────────────────────────────
const IDB_NAME    = 'meridian-models'
const IDB_STORE   = 'meta'

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

function idbRun(mode, fn) {
  return openIdb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode)
    const store = tx.objectStore(IDB_STORE)
    let result
    try { result = fn(store) } catch (e) { db.close(); reject(e); return }
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result) }
    tx.onerror    = () => { db.close(); reject(tx.error) }
    tx.onabort    = () => { db.close(); reject(tx.error || new Error('aborted')) }
  }))
}

async function evictModelCache(modelId) {
  if (typeof caches === 'undefined') return 0
  const slug = modelId.split('/').pop()
  let evicted = 0
  for (const name of await caches.keys()) {
    const cache = await caches.open(name)
    for (const req of await cache.keys()) {
      let url
      try { url = new URL(req.url) } catch { continue }
      if (!url.hostname.includes('huggingface.co')) continue
      if (!url.pathname.includes(slug)) continue
      if (await cache.delete(req)) evicted++
    }
  }
  return evicted
}

async function ensureFreshCache(slot) {
  const cfg = MODELS[slot]
  const key = `version:${slot}`
  let stored = null
  try { stored = await idbRun('readonly', s => s.get(key)) }
  catch (e) { console.warn(`[edge-inference] IDB read failed for ${slot}:`, e) }

  if (stored && stored !== cfg.version) {
    const n = await evictModelCache(cfg.id).catch(() => 0)
    console.info(`[edge-inference] ${slot}: ${stored} → ${cfg.version}, evicted ${n} entries`)
  }
  if (stored !== cfg.version) {
    try { await idbRun('readwrite', s => s.put(cfg.version, key)) }
    catch (e) { console.warn(`[edge-inference] IDB write failed for ${slot}:`, e) }
  }
}

// ── persistent storage ───────────────────────────────────────────────
// Without this, Cache Storage / IDB are "best-effort" and get evicted
// under disk pressure — the canonical bug behind "why did I re-download
// 1.8 GB this morning?". Must run on a user gesture in some browsers.
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false }
  try {
    const already = await navigator.storage.persisted?.()
    if (already) return { supported: true, persisted: true, already: true }
    const granted = await navigator.storage.persist()
    return { supported: true, persisted: !!granted }
  } catch (e) {
    return { supported: true, persisted: false, error: String(e) }
  }
}

// ── generic loader ───────────────────────────────────────────────────
const _promises = {}

function wrapProgress(onProgress, onStatus) {
  return (p) => {
    if (p?.status === 'progress' && typeof p.progress === 'number')
      onProgress?.(p.progress, p.file)
    else if (p?.status)
      onStatus?.(p.status, p.file)
  }
}

async function loadSlot(slot, { onProgress, onStatus } = {}) {
  if (_promises[slot]) return _promises[slot]
  const cfg = MODELS[slot]
  if (!cfg) throw new Error(`unknown model slot: ${slot}`)
  if (cfg.stub) throw new Error(`model slot '${slot}' is a stub — see MODELS[${slot}] TODO`)

  _promises[slot] = (async () => {
    onStatus?.('init')
    await ensureFreshCache(slot)
    const useGpu = !!navigator.gpu
    const Klass = AUTO_CLASSES[cfg.autoClass]
    if (!Klass) throw new Error(`unknown autoClass ${cfg.autoClass} for ${slot}`)

    // Tokenizer / processor — vision needs AutoProcessor, text needs AutoTokenizer.
    // Some models (e.g. esm) have neither.
    let processor = null, tokenizer = null
    if (cfg.family === 'smolvlm' || cfg.family === 'moondream') {
      processor = await AutoProcessor.from_pretrained(cfg.id, {
        progress_callback: wrapProgress(onProgress, onStatus),
      })
    } else if (cfg.family === 'llama' || cfg.family === 'qwen') {
      tokenizer = await AutoTokenizer.from_pretrained(cfg.id, {
        progress_callback: wrapProgress(onProgress, onStatus),
      })
    }
    onStatus?.('weights')
    // Per-slot dtype: 3B-class LLMs need q4f16 (not fp16) to fit on WebGPU.
    // Smaller models (SmolVLM, ESM-2) stay at fp16 for quality.
    const dtype  = cfg.dtypes?.[useGpu ? 'webgpu' : 'wasm']
                   ?? (useGpu ? 'fp16' : 'q4')
    const model = await Klass.from_pretrained(cfg.id, {
      dtype,
      device: useGpu ? 'webgpu' : 'wasm',
      progress_callback: wrapProgress(onProgress, onStatus),
    })
    onStatus?.('ready')
    return { cfg, processor, tokenizer, model, device: useGpu ? 'webgpu' : 'wasm' }
  })()

  return _promises[slot]
}

export const loadVision           = (opts) => loadSlot('vision', opts)
export const loadLLM              = (opts) => loadSlot('llm', opts)
export const loadProteinEmbedder  = (opts) => loadSlot('protein', opts)

export function isLoaded(slot) { return !!_promises[slot] }
