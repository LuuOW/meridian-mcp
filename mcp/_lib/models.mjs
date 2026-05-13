// Canonical browser-model registry for ask-meridian.uk apps.
//
// Every app served from the shared origin (lens, vision-lab, helix, future)
// imports model IDs from here so the SmolVLM / Llama / ESM weights are
// downloaded ONCE per device and reused across paths.
//
// Bump the `version` field on a model when swapping it or its quantization;
// edge-inference.mjs reads that to evict stale Cache Storage entries on the
// next load. The HF id stays stable.

export const MODELS = {
  // ── vision ────────────────────────────────────────────────────────
  vision: {
    id:      'HuggingFaceTB/SmolVLM-256M-Instruct',
    label:   'SmolVLM-256M',
    family:  'smolvlm',
    purpose: 'image → text (description, OCR, scene understanding)',
    weight:  '~250 MB (q4)',
    version: 'SmolVLM-256M-Instruct/fp16-q4@1',
    autoClass: 'AutoModelForVision2Seq',
    // fp16 fits comfortably on WebGPU for 256M params (~512 MB).
    dtypes: { webgpu: 'fp16', wasm: 'q4' },
  },

  // ── llm ───────────────────────────────────────────────────────────
  llm: {
    id:      'onnx-community/Llama-3.2-3B-Instruct',
    label:   'Llama-3.2-3B-Instruct',
    family:  'llama',
    purpose: 'text reasoning, ranking, JSON output',
    weight:  '~1.8 GB (q4f16)',
    version: 'Llama-3.2-3B-Instruct/q4f16@1',
    autoClass: 'AutoModelForCausalLM',
    // 3B at fp16 = ~6 GB → exceeds WebGPU buffer ceiling. q4f16
    // (q4 weights, fp16 compute) is the transformers.js recommendation
    // for browser-side Llama-3.2 — ~1.8 GB, runs on any GPU with WebGPU.
    dtypes: { webgpu: 'q4f16', wasm: 'q4' },
  },

  // ── protein embedder ──────────────────────────────────────────────
  // facebook/esm2_t30_150M_UR50D has no official ONNX release; the
  // conversion script at helix/scripts/convert_esm2.py is a one-shot
  // that produces int8 ONNX (~80 MB) and uploads to luuow/esm2-150M-onnx.
  // Remove `stub: true` once the upload is done.
  protein: {
    id:      'luuow/esm2-150M-onnx',
    label:   'ESM-2-150M',
    family:  'esm2',
    purpose: 'protein sequence embeddings, similarity, variant scoring',
    weight:  '~80 MB (int8)',
    version: 'esm2-150M/int8@1',
    autoClass: 'AutoModel',
    dtypes: { webgpu: 'fp16', wasm: 'q8' },
    stub: true,  // remove once convert_esm2.py has run
  },
}

// Stable Cache Storage name. Bump on breaking cache-layout changes.
export const CACHE_NAME = 'meridian-models-v1'

// SW pins responses from these hosts. transformers.js fetches weights
// from huggingface.co and the CDN aliases below — pinning all four means
// regional routing doesn't trigger a re-download.
export const PIN_HOSTS = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
])
