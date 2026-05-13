// helix front-end orchestrator (server-side inference).
//
// All inference runs on the cf-worker at mcp.ask-meridian.uk via two
// endpoints:
//   POST /v1/vision  — image → text description (GPT-4o-mini)
//   POST /v1/helix   — injury description + curated protein table
//                       → ranked top-N JSON (Llama-3.3-70B)
//
// Browser bundle: ~10 KB. No models cached locally.

const API_BASE  = 'https://mcp.ask-meridian.uk'
const TIMEOUT_MS = 60_000

// ── Seed therapeutic protein table — sent with each /v1/helix POST.
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

// ── DOM
const $    = id => document.getElementById(id)
const desc = $('desc'), runBtn = $('run'), loadBtn = $('load')
const statusEl = $('status'), progEl = $('prog'), resultsEl = $('results')
const proteinsEl = $('proteins'), debugEl = $('debug')
const imgInput = $('img-input'), imgPreview = $('img-preview'), vlmStatus = $('vlm-status')

// "Load models" is now a no-op — kept so the UI doesn't change shape.
// First call to /v1/helix takes ~3 s; no warmup needed.
loadBtn.addEventListener('click', () => {
  statusEl.textContent = 'ready (server-side inference, no download needed)'
  runBtn.disabled = !desc.value.trim()
  loadBtn.disabled = true
  progEl.hidden = true
})

// On first paint, enable run as soon as there's a description.
runBtn.disabled = true
desc.addEventListener('input', () => {
  runBtn.disabled = !desc.value.trim()
})

// ── Recommend flow
runBtn.addEventListener('click', async () => {
  if (!desc.value.trim()) return
  runBtn.disabled = true
  resultsEl.hidden = true
  proteinsEl.innerHTML = ''
  statusEl.textContent = 'calling /v1/helix (Llama-3.3-70B)…'

  try {
    const json = await postJson('/v1/helix', {
      injury_description: desc.value.trim(),
      candidates: SEED_PROTEINS,
      limit: 5,
    })
    debugEl.textContent = JSON.stringify(json, null, 2)
    renderRanked(json)
    statusEl.textContent = 'done'
  } catch (e) {
    statusEl.textContent = `failed: ${e.message}`
    console.error(e)
  } finally {
    runBtn.disabled = false
  }
})

// ── Vision flow
imgInput.addEventListener('change', async () => {
  const file = imgInput.files?.[0]
  if (!file) return

  const url = URL.createObjectURL(file)
  imgPreview.src = url
  imgPreview.style.display = 'inline-block'

  vlmStatus.textContent = 'uploading + describing (GPT-4o-mini)…'
  try {
    const dataUri = await fileToDataUri(file)
    const { description } = await postJson('/v1/vision', {
      image_url: dataUri,
      prompt: 'Describe this injury in clinical terms: tissue type, depth, size, severity, any visible contamination or bleeding. Be concise (2-3 sentences). If the image does not show an injury, say so.',
    })
    desc.value = description + (desc.value ? '\n\n' + desc.value : '')
    desc.dispatchEvent(new Event('input'))
    vlmStatus.textContent = 'described'
  } catch (e) {
    vlmStatus.textContent = `describe failed: ${e.message}`
    console.error(e)
  } finally {
    URL.revokeObjectURL(url)
  }
})

// ── Helpers
async function postJson(path, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    return j
  } finally {
    clearTimeout(timer)
  }
}

function fileToDataUri(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload  = () => res(fr.result)
    fr.onerror = rej
    fr.readAsDataURL(file)
  })
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
