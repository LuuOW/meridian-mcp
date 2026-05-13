// helix front-end — galaxy view orchestrator.
//
// Flow:
//   1. user types injury (or adds photo)
//   2. (auto on Cmd/Ctrl+Enter or button) POST /v1/helix → ranked
//      proteins with orbital classification
//   3. top-1 protein's PDB renders in the central Mol* host (the "star")
//   4. all candidates render as orbiting planets via miniapp's MiniGalaxy
//   5. click a planet → detail panel slides in with LLM score, orbital
//      route_score, delivery flags
//
// Models behind the curtain: Llama-3.3-70B for ranking + rationale,
// GPT-4o-mini for photo description, classifier is mcp/_lib/orbital.mjs
// running in the cf-worker. Zero ML in the browser.

import { MiniGalaxy } from '/miniapp/mini-galaxy.js'

const API_BASE   = 'https://mcp.ask-meridian.uk'
const TIMEOUT_MS = 60_000

// PDB ids hand-mapped per UniProt so the central Mol* viewer has
// something to load. Picked the canonical structure for each.
const SEED_PROTEINS = [
  { uniprot: 'P01133', pdb: '1JL9', name: 'EGF',         use: 'corneal abrasion, skin re-epithelialization', aa_len: 53,   notes: 'small, stable, FDA-approved as recombinant' },
  { uniprot: 'P21583', pdb: '1QQK', name: 'KGF/FGF-7',   use: 'skin burn, mucositis',                         aa_len: 194,  notes: 'palifermin is approved biologic' },
  { uniprot: 'P09038', pdb: '1BFF', name: 'bFGF/FGF-2',  use: 'skin wound, angiogenesis',                     aa_len: 288,  notes: 'trafermin is approved in Japan' },
  { uniprot: 'P02788', pdb: '1LFG', name: 'Lactoferrin', use: 'ocular dryness, antimicrobial',                aa_len: 710,  notes: 'OTC topical in some markets' },
  { uniprot: 'Q6UWN8', pdb: '4WTI', name: 'Lubricin',    use: 'corneal lubrication',                          aa_len: 1404, notes: 'recombinant in clinical trials for dry eye' },
  { uniprot: 'P01308', pdb: '3I40', name: 'Insulin',     use: 'corneal nerve regeneration (off-label)',       aa_len: 110,  notes: 'small, stable' },
  { uniprot: 'P05230', pdb: '1AFC', name: 'aFGF/FGF-1',  use: 'wound healing, neural regeneration',           aa_len: 155,  notes: 'recombinant in trials' },
  { uniprot: 'P14210', pdb: '1NK1', name: 'HGF',         use: 'corneal endothelial regen',                    aa_len: 728,  notes: 'large, delivery challenging' },
  { uniprot: 'P10145', pdb: '5D14', name: 'IL-8',        use: 'modulates neutrophil response — NOT therapeutic alone', aa_len: 99, notes: 'included as negative control' },
  { uniprot: 'P01023', pdb: '1BV8', name: 'Alpha-2-M',   use: 'protease inhibitor, anti-inflammatory',        aa_len: 1474, notes: 'large; topical delivery hard' },
]

// ── DOM
const $ = id => document.getElementById(id)
const desc = $('desc'), runBtn = $('run')
const statusEl = $('status'), debugEl = $('debug')
const imgInput = $('img-input'), imgPreview = $('img-preview')
const galaxyCanvas = $('galaxy'), molstarHost = $('molstar'), centerHint = $('centerHint')
const detail = $('detailPanel')
const burgerBtn = $('burgerBtn'), navMenu = $('navMenu')

let lastResult = null
let lastCandidates = []
let molstarPlugin = null
let galaxy = null

// ── Burger menu (mirrors landing's initBurgerNav, inlined)
function initBurger() {
  const toggle = (open) => {
    const isOpen = open !== undefined ? open : !navMenu.classList.contains('open')
    navMenu.classList.toggle('open', isOpen)
    burgerBtn.classList.toggle('open', isOpen)
    burgerBtn.setAttribute('aria-expanded', String(isOpen))
  }
  burgerBtn.addEventListener('click', e => { e.stopPropagation(); toggle() })
  navMenu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggle(false)))
  document.addEventListener('click', e => {
    if (!navMenu.classList.contains('open')) return
    if (!navMenu.contains(e.target) && !burgerBtn.contains(e.target)) toggle(false)
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false) })
}
initBurger()

// ── Galaxy renderer
galaxy = new MiniGalaxy(galaxyCanvas, {
  mode: '3d',
  onPlanetClick: (slug) => showDetail(slug),
})

// ── Mol* lazy bootstrap. The plugin is ~1.8 MB JS; load once on first
// successful /v1/helix response. Until then the central spot shows a
// soft glow + hint text.
async function ensureMolstar() {
  if (molstarPlugin) return molstarPlugin
  const mod = await import('https://cdn.jsdelivr.net/npm/molstar@4.7.0/+esm')
  molstarPlugin = await mod.createPluginUI({
    target: molstarHost,
    spec: {
      ...mod.DefaultPluginUISpec(),
      layout: {
        initial: {
          isExpanded: false,
          showControls: false,
          regionState: { left: 'hidden', right: 'hidden', top: 'hidden', bottom: 'hidden' },
        },
      },
      config: [[mod.PluginConfig.Viewport.ShowControls, false],
               [mod.PluginConfig.Viewport.ShowSelectionMode, false]],
    },
    render: mod.renderReact18,
  })
  return molstarPlugin
}

async function loadStructure(pdbId) {
  const plugin = await ensureMolstar()
  centerHint.classList.add('hidden')
  molstarHost.classList.remove('empty')
  // Clear previous, then load fresh
  await plugin.clear()
  const url = `https://files.rcsb.org/download/${pdbId}.pdb`
  const data = await plugin.builders.data.download({ url, isBinary: false }, { state: { isGhost: true } })
  const traj = await plugin.builders.structure.parseTrajectory(data, 'pdb')
  await plugin.builders.structure.hierarchy.applyPreset(traj, 'default')
}

// ── Recommend flow
async function recommend() {
  if (!desc.value.trim()) return
  runBtn.disabled = true
  setStatus('calling /v1/helix (Llama-3.3-70B + classifier)…', 'busy')
  try {
    const json = await postJson('/v1/helix', {
      injury_description: desc.value.trim(),
      candidates: SEED_PROTEINS,
      limit: 5,
    })
    lastResult = json
    debugEl.textContent = JSON.stringify(json, null, 2)

    const cands = (json.candidates || []).slice(0, 7)
    lastCandidates = cands.map(c => {
      const seed = SEED_PROTEINS.find(s => s.uniprot === (c.uniprot || c.slug))
      return { ...c, ...seed, slug: c.slug || c.uniprot }
    })
    galaxy.setCandidates(lastCandidates)

    const top = lastCandidates[0]
    if (top?.pdb) {
      setStatus(`top: ${top.name} (PDB ${top.pdb})`, '')
      await loadStructure(top.pdb).catch(e => {
        setStatus(`structure ${top.pdb} failed: ${e.message}`, 'error')
      })
    }
    setStatus(`${lastCandidates.length} candidates · click a planet`, '')
  } catch (e) {
    setStatus(`failed: ${e.message}`, 'error')
    console.error(e)
  } finally {
    runBtn.disabled = false
  }
}

// ── Vision flow
imgInput.addEventListener('change', async () => {
  const file = imgInput.files?.[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  imgPreview.src = url; imgPreview.classList.add('shown')

  setStatus('describing photo (GPT-4o-mini)…', 'busy')
  try {
    const dataUri = await fileToDataUri(file)
    const { description } = await postJson('/v1/vision', {
      image_url: dataUri,
      prompt: 'Describe this injury in clinical terms: tissue type, depth, size, severity, any visible contamination or bleeding. Be concise (2-3 sentences). If the image does not show an injury, say so.',
    })
    desc.value = description + (desc.value ? '\n\n' + desc.value : '')
    setStatus('photo described — review and send', '')
    // Auto-trigger after a short pause so user sees the description first
    debouncedRecommend()
  } catch (e) {
    setStatus(`describe failed: ${e.message}`, 'error')
  } finally {
    URL.revokeObjectURL(url)
  }
})

// ── UX: Cmd/Ctrl+Enter sends; idle debounce auto-sends after 1.5 s
let debounceTimer = null
function debouncedRecommend() {
  clearTimeout(debounceTimer)
  if (!desc.value.trim()) return
  debounceTimer = setTimeout(() => recommend(), 1500)
}
desc.addEventListener('input', () => {
  setStatus('typing… (auto-send in 1.5 s, or Cmd+Enter)', '')
  debouncedRecommend()
})
desc.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    clearTimeout(debounceTimer)
    recommend()
  }
})
runBtn.addEventListener('click', () => {
  clearTimeout(debounceTimer)
  recommend()
})

// ── Detail panel
function showDetail(slug) {
  const c = lastCandidates.find(x => x.slug === slug)
  if (!c) return
  $('detailTitle').textContent = `${c.name} · ${c.uniprot}`
  $('detailMeta').textContent  = `${c.aa_len ?? '?'} aa · PDB ${c.pdb || '—'}`
  $('detailRationale').textContent = c.rationale || c.description || ''

  const scores = $('detailScores'); scores.innerHTML = ''
  if (c.llm_score != null) scores.appendChild(pill(`LLM ${c.llm_score}/100`))
  if (c.route_score != null) scores.appendChild(pill(`orbital ${c.route_score.toFixed(2)}`))
  if (c.classification?.class) scores.appendChild(pill(c.classification.class, 'warm'))

  let notes = `<div>${escapeHtml(c.notes || '')}</div>`
  if (c.delivery_concern) notes += `<div class="concern">⚠ delivery: ${escapeHtml(c.delivery_concern)}</div>`
  $('detailNotes').innerHTML = notes
  detail.hidden = false

  // Click on a different planet replaces the center structure too
  if (c.pdb && c.pdb !== lastResult?.__currentPdb) {
    lastResult.__currentPdb = c.pdb
    loadStructure(c.pdb).catch(() => {})
  }
}
detail.querySelector('.detail-close').addEventListener('click', () => { detail.hidden = true })

// ── Helpers
function pill(text, cls = '') {
  const s = document.createElement('span')
  s.className = 'pill ' + cls; s.textContent = text
  return s
}
function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = 'status' + (cls ? ' ' + cls : '')
}
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
  } finally { clearTimeout(timer) }
}
function fileToDataUri(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload  = () => res(fr.result)
    fr.onerror = rej
    fr.readAsDataURL(file)
  })
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

// Mark hint as empty-state at boot
molstarHost.classList.add('empty')
