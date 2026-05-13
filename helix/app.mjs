// helix front-end — one star system per predicted protein.
//
// Each candidate gets its own complete world rendered as a card:
//   • star at center: the protein's 3D structure (Mol* cartoon)
//   • orbiting bodies: the protein's REAL chemical components — the
//     ligands, cofactors, ions, and glycans actually present in the
//     PDB file (HETATM records), each shown as its 2D molecular
//     structure from RCSB's Chemical Component Dictionary.
//
// Server-side classifier loop unchanged: /v1/helix runs Llama-3.3-70B
// for ranking + rationale, then orbitalClassify() positions each
// protein with the project's canonical physics signature.

import { drawCompound, parseHETsFromPdb, labelFor } from './molecules.mjs'

const API_BASE   = 'https://mcp.ask-meridian.uk'
const TIMEOUT_MS = 60_000

// PDB ids per UniProt. Compounds are auto-extracted from each PDB at
// render time — no hardcoded `compounds:` field anymore. Whatever
// HETATM records are in the structure (minus crystallization noise)
// show up as orbiting molecules.
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
const universe = $('universe'), detail = $('detailPanel')
const burgerBtn = $('burgerBtn'), navMenu = $('navMenu')

let lastResult = null
let lastCandidates = []
const systemViewers = new Map()   // pdb → Mol* Viewer

// ── Burger menu (mirrors landing/nav.js initBurgerNav)
function initBurger() {
  if (!burgerBtn || !navMenu) return
  const toggle = (open) => {
    const isOpen = open !== undefined ? open : !navMenu.classList.contains('open')
    navMenu.classList.toggle('open', isOpen)
    burgerBtn.classList.toggle('open', isOpen)
    burgerBtn.setAttribute('aria-expanded', String(isOpen))
    if (isOpen) {
      const first = navMenu.querySelector('a')
      if (first) setTimeout(() => first.focus(), 50)
    } else {
      burgerBtn.focus()
    }
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

// Wait for window.molstar to land — the UMD bundle attaches on
// DOMContentLoaded. Promise resolves the moment it's available.
function molstarReady() {
  return new Promise((resolve, reject) => {
    if (window.molstar?.Viewer) return resolve(window.molstar)
    let tries = 0
    const t = setInterval(() => {
      tries++
      if (window.molstar?.Viewer) { clearInterval(t); resolve(window.molstar) }
      else if (tries > 80) { clearInterval(t); reject(new Error('molstar bundle did not load')) }
    }, 50)
  })
}

// Fetch PDB text once and hand it to BOTH Mol* (for the protein render)
// and our HET parser (for compound coordinates). One network round-trip,
// shared parsing. Uses the prebuilt window.molstar.Viewer API — the
// npm package's createPluginUI path requires a bundler we don't have.
async function loadProteinAndExtractHETs(host, pdbId) {
  const [pdbText, mol] = await Promise.all([
    fetch(`https://files.rcsb.org/download/${pdbId}.pdb`).then(r => r.text()),
    molstarReady(),
  ])
  const viewer = await mol.Viewer.create(host, {
    layoutIsExpanded:       false,
    layoutShowControls:     false,
    layoutShowRemoteState:  false,
    layoutShowSequence:     false,
    layoutShowLog:          false,
    layoutShowLeftPanel:    false,
    viewportShowExpand:     false,
    viewportShowSelectionMode: false,
    viewportShowAnimation:  false,
    pdbProvider:            'rcsb',
    emdbProvider:           'rcsb',
  })
  systemViewers.set(pdbId, viewer)
  await viewer.loadStructureFromData(pdbText, 'pdb')
  return parseHETsFromPdb(pdbText)
}

// ── Render a single star system card
function renderSystem(c, rank) {
  const card = document.createElement('article')
  card.className = 'system'
  card.dataset.slug = c.slug

  card.innerHTML = `
    <header class="system-header">
      <span class="system-rank">${rank + 1}</span>
      <span class="system-name">${escapeHtml(c.name || '?')}</span>
      <span class="system-uniprot">${escapeHtml(c.uniprot || '')}</span>
    </header>

    <div class="system-orbits"></div>
    <div class="system-center ${c.pdb ? '' : 'empty'}">
      ${c.pdb ? '' : 'no PDB'}
    </div>

    <footer class="system-footer">
      <div class="system-scores">
        ${c.llm_score   != null ? `<span class="score-pill">LLM ${c.llm_score}/100</span>` : ''}
        ${c.route_score != null ? `<span class="score-pill warm">orbital ${Number(c.route_score).toFixed(2)}</span>` : ''}
        ${c.classification?.class ? `<span class="score-pill dim">${escapeHtml(c.classification.class)}</span>` : ''}
      </div>
      <div class="system-rationale">${escapeHtml(c.rationale || c.description || c.use || '')}</div>
    </footer>
  `

  card.addEventListener('click', () => showDetail(c))
  universe.appendChild(card)

  const orbitsEl = card.querySelector('.system-orbits')
  const centerEl = card.querySelector('.system-center')

  if (!c.pdb) return

  // Fetch the PDB once, render the protein, extract HETs, then place
  // the orbiting compounds. Each compound's atom coords come from the
  // same PDB Mol* is showing — so what you see in orbit is literally
  // what's bound to the protein in the experimental structure.
  loadProteinAndExtractHETs(centerEl, c.pdb)
    .then(compounds => {
      compounds.forEach((mol, i) => {
        const angle = (360 / Math.max(compounds.length, 1)) * i
        const el = document.createElement('div')
        el.className = 'compound'
        el.style.setProperty('--angle',  `${angle}deg`)
        el.style.setProperty('--radius', '130px')
        el.title = mol.label
        el.innerHTML = `
          <div class="compound-body">
            <div class="compound-icon"><canvas width="56" height="56"></canvas></div>
            <div class="compound-label">${escapeHtml(mol.label)}</div>
          </div>
        `
        orbitsEl.appendChild(el)
        const canvas = el.querySelector('canvas')
        if (canvas) drawCompound(canvas, mol)
      })
    })
    .catch(e => {
      console.warn('mol*', c.pdb, 'failed:', e?.message || e)
      centerEl.classList.add('empty')
      centerEl.textContent = `PDB ${c.pdb} failed`
    })
}

function clearUniverse() {
  // Tear down existing Mol* viewers before wiping the DOM, otherwise
  // we leak WebGL contexts. 5+ stale contexts → browser drops the page.
  for (const [, viewer] of systemViewers) {
    try { viewer.dispose ? viewer.dispose() : viewer.plugin?.dispose?.() } catch {}
  }
  systemViewers.clear()
  universe.innerHTML = ''
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

    const cands = (json.candidates || []).slice(0, 5).map(c => {
      const seed = SEED_PROTEINS.find(s => s.uniprot === (c.uniprot || c.slug)) || {}
      return { ...seed, ...c, slug: c.slug || c.uniprot, pdb: seed.pdb }
    })
    lastCandidates = cands
    if (!cands.length) {
      setStatus('no candidates returned', 'error')
      return
    }

    clearUniverse()
    cands.forEach((c, i) => renderSystem(c, i))

    setStatus(`${cands.length} systems · top: ${cands[0].name}`, '')
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
    debouncedRecommend()
  } catch (e) {
    setStatus(`describe failed: ${e.message}`, 'error')
  } finally {
    URL.revokeObjectURL(url)
  }
})

// ── Auto-fire
let debounceTimer = null
function debouncedRecommend() {
  clearTimeout(debounceTimer)
  if (!desc.value.trim()) return
  debounceTimer = setTimeout(() => recommend(), 1500)
}
desc.addEventListener('input', () => {
  setStatus('typing… auto-send in 1.5 s, or Cmd+Enter', '')
  debouncedRecommend()
})
desc.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault(); clearTimeout(debounceTimer); recommend()
  }
})
runBtn.addEventListener('click', () => { clearTimeout(debounceTimer); recommend() })

// ── Detail panel
function showDetail(c) {
  $('detailTitle').textContent = `${c.name} · ${c.uniprot || c.slug}`
  $('detailMeta').textContent  = `${c.aa_len ?? '?'} aa · PDB ${c.pdb || '—'}`
  $('detailRationale').textContent = c.rationale || c.description || ''

  const scores = $('detailScores'); scores.innerHTML = ''
  if (c.llm_score   != null) scores.appendChild(pill(`LLM ${c.llm_score}/100`))
  if (c.route_score != null) scores.appendChild(pill(`orbital ${Number(c.route_score).toFixed(2)}`))
  if (c.classification?.class) scores.appendChild(pill(c.classification.class, 'warm'))

  let notes = `<div>${escapeHtml(c.notes || '')}</div>`
  if (c.delivery_concern) notes += `<div class="concern">⚠ delivery: ${escapeHtml(c.delivery_concern)}</div>`
  $('detailNotes').innerHTML = notes
  detail.hidden = false
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
