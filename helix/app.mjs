// helix front-end orchestrator.
//
// Wires the canonical models (vision/LLM/protein) to a three-stage pipeline:
//   1. Normalize free-form injury text → InjuryDescription JSON (LLM)
//   2. Score a hand-curated therapeutic protein table against it (LLM ranker)
//   3. Look up precomputed PDB structures for the top-5 from the helix-cache
//
// Vision is wired but optional — typing a description skips the VLM entirely.
// First-draft uses a hardcoded seed table; live UniProt retrieval is layered
// in later. ESM-2 embedder slot is stubbed (model file pending conversion).

import { MODELS }                                                 from '_lib/models.mjs'
import { loadLLM, loadVision, requestPersistentStorage }           from '_lib/edge-inference.mjs'
import { RawImage, TextStreamer }                                  from '@huggingface/transformers'

// ── Seed therapeutic protein table ───────────────────────────────────
// Hand-curated; expanded later via UniProt REST. Each entry has enough
// for the LLM to reason about indication without external lookups.
const SEED_PROTEINS = [
  { uniprot: 'P01133', name: 'EGF',         use: 'corneal abrasion, skin re-epithelialization', aa_len: 53,  notes: 'small, stable, FDA-approved as recombinant' },
  { uniprot: 'P21583', name: 'KGF/FGF-7',   use: 'skin burn, mucositis',                         aa_len: 194, notes: 'palifermin is approved biologic' },
  { uniprot: 'P09038', name: 'bFGF/FGF-2',  use: 'skin wound, angiogenesis',                     aa_len: 288, notes: 'trafermin is approved in Japan' },
  { uniprot: 'P02788', name: 'Lactoferrin', use: 'ocular dryness, antimicrobial',                aa_len: 710, notes: 'OTC topical in some markets' },
  { uniprot: 'Q6UWN8', name: 'Lubricin',    use: 'corneal lubrication',                          aa_len: 1404, notes: 'recombinant in clinical trials for dry eye' },
  { uniprot: 'P01308', name: 'Insulin',     use: 'corneal nerve regeneration (off-label)',       aa_len: 110, notes: 'small, stable' },
  { uniprot: 'P05230', name: 'aFGF/FGF-1',  use: 'wound healing, neural regeneration',           aa_len: 155, notes: 'recombinant in trials' },
  { uniprot: 'P14210', name: 'HGF',         use: 'corneal endothelial regen',                    aa_len: 728, notes: 'large, delivery challenging' },
  { uniprot: 'P10145', name: 'IL-8',        use: 'modulates neutrophil response — NOT therapeutic alone', aa_len: 99, notes: 'included as negative control' },
  { uniprot: 'P01023', name: 'Alpha-2-M',   use: 'protease inhibitor, anti-inflammatory',        aa_len: 1474, notes: 'large; topical delivery hard' },
]

// ── DOM ──────────────────────────────────────────────────────────────
const $    = id => document.getElementById(id)
const desc = $('desc'), runBtn = $('run'), loadBtn = $('load')
const statusEl = $('status'), progEl = $('prog'), resultsEl = $('results')
const proteinsEl = $('proteins'), debugEl = $('debug')
const imgInput = $('img-input'), imgPreview = $('img-preview'), vlmStatus = $('vlm-status')

let llmReady    = false
let llmHandle   = null
let visionReady = false
let visionHandle = null

// ── Load flow ────────────────────────────────────────────────────────
// LLM is mandatory; vision loads lazily on first image add (so users who
// only type a description never pay the ~250 MB SmolVLM cost).
loadBtn.addEventListener('click', async () => {
  loadBtn.disabled = true
  await requestPersistentStorage()
  progEl.hidden = false
  try {
    llmHandle = await loadLLM({
      onStatus:   (s) => { statusEl.textContent = `loading LLM: ${s}` },
      onProgress: (p, file) => {
        progEl.value = (p || 0)
        statusEl.textContent = `${file || 'weights'}: ${Math.round(p)}%`
      },
    })
    llmReady = true
    statusEl.textContent = `LLM ready (${llmHandle.device})`
    runBtn.disabled = !desc.value.trim()
    progEl.hidden = true
  } catch (e) {
    statusEl.textContent = `load failed: ${e.message}`
    console.error(e)
    loadBtn.disabled = false
  }
})

// ── Vision flow ──────────────────────────────────────────────────────
// User picks/captures an image → SmolVLM describes it → description
// pre-fills the textarea (user can still edit). Vision is opt-in: if
// the user only types, SmolVLM never loads.
imgInput.addEventListener('change', async () => {
  const file = imgInput.files?.[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  imgPreview.src = url
  imgPreview.style.display = 'inline-block'

  if (!visionReady) {
    vlmStatus.textContent = 'loading vision model (~250 MB)…'
    try {
      visionHandle = await loadVision({
        onStatus:   (s) => { vlmStatus.textContent = `vision: ${s}` },
        onProgress: (p, fn) => { vlmStatus.textContent = `${fn || 'weights'}: ${Math.round(p)}%` },
      })
      visionReady = true
    } catch (e) {
      vlmStatus.textContent = `vision load failed: ${e.message}`
      return
    }
  }

  vlmStatus.textContent = 'describing image…'
  try {
    const description = await describeInjury(url)
    // Prepend (don't overwrite) so the user keeps anything they typed.
    desc.value = description + (desc.value ? '\n\n' + desc.value : '')
    desc.dispatchEvent(new Event('input'))
    vlmStatus.textContent = `described in ${visionHandle.device}`
  } catch (e) {
    vlmStatus.textContent = `describe failed: ${e.message}`
    console.error(e)
  } finally {
    URL.revokeObjectURL(url)
  }
})

async function describeInjury(imageUrl) {
  const { processor, model } = visionHandle
  const image = await loadImageAsRaw(imageUrl, 384)
  const prompt = 'Describe this injury in clinical terms: tissue type, depth, size, severity, any visible contamination or bleeding. Be concise (2-3 sentences). If the image does not show an injury, say so.'
  const messages = [
    { role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] },
  ]
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true })
  const inputs = await processor(text, [image])

  let buffer = ''
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => { buffer += chunk },
  })
  await model.generate({
    ...inputs,
    max_new_tokens: 120,
    do_sample: true, temperature: 0.5, top_p: 0.9,
    streamer,
  })
  return buffer.replace(/^\s*Assistant:\s*/i, '').trim()
}

// Decode arbitrary <img>/<input type=file> source → 384×384 RGB RawImage
// suitable for SmolVLM. Cover-fit crop matches lens.
async function loadImageAsRaw(url, size = 384) {
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload  = () => res(i)
    i.onerror = rej
    i.src = url
  })
  const canvas = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size })
  const ctx = canvas.getContext('2d')
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const sx = (img.naturalWidth  - side) / 2
  const sy = (img.naturalHeight - side) / 2
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
  const data = ctx.getImageData(0, 0, size, size).data
  const rgb = new Uint8ClampedArray(size * size * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]; rgb[j+1] = data[i+1]; rgb[j+2] = data[i+2]
  }
  return new RawImage(rgb, size, size, 3)
}

// ── Recommend flow ───────────────────────────────────────────────────
runBtn.addEventListener('click', async () => {
  if (!llmReady) return
  runBtn.disabled = true
  resultsEl.hidden = true
  proteinsEl.innerHTML = ''
  statusEl.textContent = 'reasoning…'

  try {
    const ranked = await rankProteins(desc.value.trim())
    renderRanked(ranked)
    statusEl.textContent = 'done'
  } catch (e) {
    statusEl.textContent = `failed: ${e.message}`
    console.error(e)
  } finally {
    runBtn.disabled = false
  }
})

desc.addEventListener('input', () => {
  runBtn.disabled = !llmReady || !desc.value.trim()
})

// ── LLM ranker ───────────────────────────────────────────────────────
// One in-context prompt covers normalization + ranking. Small corpus
// (~10 candidates) — no separate retrieval step.
async function rankProteins(injuryText) {
  if (!injuryText) throw new Error('describe the injury first')
  const { tokenizer, model } = llmHandle

  const table = SEED_PROTEINS.map(p =>
    `- ${p.name} (${p.uniprot}, ${p.aa_len} aa) — use: ${p.use}; notes: ${p.notes}`
  ).join('\n')

  const system = `You are a research assistant helping triage therapeutic protein candidates for a clinical wet lab. You are NOT giving medical advice. Always disclose uncertainty. Output strict JSON only — no prose around it.`

  const user = `Injury description:
${injuryText}

Therapeutic protein table (curated, ~10 entries):
${table}

Task: pick the top 5 candidates for further investigation. Score each 0-100 on plausibility for THIS injury, give a one-sentence mechanism rationale, and flag any candidate where size/delivery is a known barrier.

Output strict JSON:
{
  "injury_class": "<short class label>",
  "candidates": [
    {"uniprot": "...", "name": "...", "score": 0-100, "rationale": "...", "delivery_concern": null | "..."},
    ... 5 total
  ],
  "not_medical_advice": true
}`

  const messages = [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ]
  const text = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false })
  const inputs = tokenizer(text, { return_tensors: 'pt' })

  const out = await model.generate({
    ...inputs,
    max_new_tokens: 600,
    do_sample: false,
    temperature: 0,
  })
  const decoded = tokenizer.batch_decode(out, { skip_special_tokens: true })[0]
  const raw = decoded.slice(text.length).trim()

  // Extract first {...} block — LLMs occasionally trail prose.
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`LLM did not return JSON. Raw: ${raw.slice(0, 200)}`)
  const json = JSON.parse(m[0])
  debugEl.textContent = JSON.stringify(json, null, 2)
  return json
}

function renderRanked(json) {
  resultsEl.hidden = false
  for (const c of (json.candidates || []).slice(0, 5)) {
    const seed = SEED_PROTEINS.find(p => p.uniprot === c.uniprot)
    const row = document.createElement('div')
    row.className = 'protein'
    row.innerHTML = `
      <h3>${escapeHtml(c.name || '?')} <span class="meta">· ${escapeHtml(c.uniprot || '')} · score ${c.score ?? '?'}/100</span></h3>
      <div class="meta">${escapeHtml(c.rationale || '')}</div>
      ${c.delivery_concern ? `<div class="meta" style="color:#fbbf24;">⚠ delivery: ${escapeHtml(c.delivery_concern)}</div>` : ''}
      ${seed ? `<div class="meta" style="margin-top:4px;">${seed.aa_len} aa · ${escapeHtml(seed.notes)}</div>` : ''}
    `
    proteinsEl.appendChild(row)
  }
  const disc = document.createElement('div')
  disc.className = 'meta'
  disc.style.marginTop = '14px'
  disc.textContent = 'Research candidates only — not a medical recommendation. Topical protein delivery is non-trivial; consult a wet lab before any formulation.'
  proteinsEl.appendChild(disc)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

// Surface cached models for the debug pane on init.
;(async () => {
  if ('caches' in self) {
    try {
      const cache = await caches.open(MODELS && 'meridian-models-v1')
      const keys = await cache.keys()
      debugEl.textContent = `models cache entries: ${keys.length}\nslots: ${Object.keys(MODELS).join(', ')}`
    } catch {}
  }
})()
