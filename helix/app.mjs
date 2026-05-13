// helix front-end — molecular-orbit view.
//
// The top candidate's PDB renders as a big 3D structure at center.
// Other candidates orbit around it as small 3D molecular renders
// (not dots) — same Mol* engine, separate plugin instances per moon.
// Click a moon → it swaps to center.
//
// Server-side classifier loop: /v1/helix runs Llama-3.3-70B for
// ranking, then orbitalClassify() inside cf-worker positions each
// protein with the project's canonical physics signature. Front-end
// receives both LLM and orbital scores per candidate.

const API_BASE   = 'https://mcp.ask-meridian.uk'
const TIMEOUT_MS = 60_000

// PDB ids mapped per UniProt so each protein has a structure to render.
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
const molstarHost = $('molstar'), orbitsEl = $('orbits')
const detail = $('detailPanel')
const burgerBtn = $('burgerBtn'), navMenu = $('navMenu')

let lastResult = null
let lastCandidates = []
let MolstarMod = null            // shared module exports
let centerPlugin = null          // central big Mol*
const moonPlugins = new Map()    // pdb → plugin instance

// ── Burger menu
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

// ── Mol* lazy bootstrap
async function loadMolstarMod() {
  if (MolstarMod) return MolstarMod
  MolstarMod = await import('https://cdn.jsdelivr.net/npm/molstar@4.7.0/+esm')
  return MolstarMod
}

async function makePlugin(target, big = false) {
  const m = await loadMolstarMod()
  return m.createPluginUI({
    target,
    spec: {
      ...m.DefaultPluginUISpec(),
      layout: {
        initial: {
          isExpanded: false,
          showControls: false,
          regionState: { left: 'hidden', right: 'hidden', top: 'hidden', bottom: 'hidden' },
        },
      },
      config: [
        [m.PluginConfig.Viewport.ShowControls, false],
        [m.PluginConfig.Viewport.ShowSelectionMode, false],
        [m.PluginConfig.Viewport.ShowExpand, false],
      ],
    },
    render: m.renderReact18,
  })
}

async function loadInto(plugin, pdbId) {
  await plugin.clear()
  const url = `https://files.rcsb.org/download/${pdbId}.pdb`
  const data = await plugin.builders.data.download({ url, isBinary: false }, { state: { isGhost: true } })
  const traj = await plugin.builders.structure.parseTrajectory(data, 'pdb')
  await plugin.builders.structure.hierarchy.applyPreset(traj, 'default')
}

// ── Central protein
async function loadCenter(pdbId) {
  if (!centerPlugin) {
    // Clear the empty-state hint and the host's inline children before
    // mounting Mol* (it owns the host element).
    molstarHost.innerHTML = ''
    molstarHost.classList.remove('empty')
    centerPlugin = await makePlugin(molstarHost, true)
  }
  molstarHost.classList.add('swapping')
  try { await loadInto(centerPlugin, pdbId) }
  finally { setTimeout(() => molstarHost.classList.remove('swapping'), 250) }
}

// ── Orbiting moons (small molecular renders, not dots)
async function renderOrbits(moons) {
  orbitsEl.innerHTML = ''
  const n = moons.length
  if (!n) return

  // Two concentric rings if we have >4 moons; otherwise one ring.
  const radiusPx = (i) => {
    const vmin = Math.min(window.innerWidth, window.innerHeight) / 100
    const ringIdx = (n > 4 && i >= Math.ceil(n / 2)) ? 1 : 0
    return ringIdx === 0 ? 24 * vmin : 28 * vmin
  }

  moons.forEach((c, i) => {
    const angle = (360 / n) * i
    const el = document.createElement('div')
    el.className = 'moon'
    el.style.setProperty('--angle',  `${angle}deg`)
    el.style.setProperty('--radius', `${radiusPx(i)}px`)
    el.dataset.slug = c.slug
    el.title = `${c.name} · click to focus`
    el.innerHTML = `
      <div class="moon-body">
        <div class="moon-canvas" id="moon-canvas-${c.pdb || i}"></div>
        <div class="moon-label">${escapeHtml(c.name || c.uniprot || '?')}</div>
      </div>
    `
    el.addEventListener('click', () => focusCandidate(c.slug))
    orbitsEl.appendChild(el)
  })

  // Now lazy-init Mol* for each moon canvas. Run in parallel; each one
  // is small (~30 KB PDB + a WebGL context). 5 contexts is fine.
  for (const c of moons) {
    const canvas = document.getElementById(`moon-canvas-${c.pdb || c.slug}`)
    if (!canvas || !c.pdb) continue
    makePlugin(canvas).then(p => {
      moonPlugins.set(c.pdb, p)
      return loadInto(p, c.pdb)
    }).catch(e => {
      console.warn('moon', c.pdb, 'failed:', e?.message || e)
      canvas.style.opacity = 0.3
    })
  }
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

    // Merge LLM/orbital fields with seed metadata (pdb id, aa_len, notes).
    const cands = (json.candidates || []).slice(0, 5).map(c => {
      const seed = SEED_PROTEINS.find(s => s.uniprot === (c.uniprot || c.slug)) || {}
      return { ...seed, ...c, slug: c.slug || c.uniprot, pdb: seed.pdb }
    })
    lastCandidates = cands
    if (!cands.length) {
      setStatus('no candidates returned', 'error')
      return
    }

    setStatus(`${cands.length} candidates · top: ${cands[0].name}`, '')

    // Center = top-1; moons = rest. Load center first, then orbits.
    if (cands[0]?.pdb) {
      await loadCenter(cands[0].pdb).catch(e => {
        setStatus(`center structure ${cands[0].pdb} failed: ${e.message}`, 'error')
      })
    }
    renderOrbits(cands.slice(1))
  } catch (e) {
    setStatus(`failed: ${e.message}`, 'error')
    console.error(e)
  } finally {
    runBtn.disabled = false
  }
}

// ── Focus a candidate (click moon → swap to center, push old center out)
async function focusCandidate(slug) {
  const c = lastCandidates.find(x => x.slug === slug)
  if (!c) return
  showDetail(c)
  if (!c.pdb || lastCandidates[0]?.slug === slug) return

  // Reorder lastCandidates so this one is at index 0.
  const oldTop = lastCandidates[0]
  lastCandidates = [c, oldTop, ...lastCandidates.filter(x => x.slug !== slug && x.slug !== oldTop.slug)]

  await loadCenter(c.pdb).catch(e => setStatus(`focus ${c.pdb} failed: ${e.message}`, 'error'))
  renderOrbits(lastCandidates.slice(1))
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

// ── Auto-fire: Cmd/Ctrl+Enter, or 1.5 s idle debounce
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
function showDetail(c) {
  $('detailTitle').textContent = `${c.name} · ${c.uniprot || c.slug}`
  $('detailMeta').textContent  = `${c.aa_len ?? '?'} aa · PDB ${c.pdb || '—'}`
  $('detailRationale').textContent = c.rationale || c.description || ''

  const scores = $('detailScores'); scores.innerHTML = ''
  if (c.llm_score != null)   scores.appendChild(pill(`LLM ${c.llm_score}/100`))
  if (c.route_score != null) scores.appendChild(pill(`orbital ${Number(c.route_score).toFixed(2)}`))
  const klass = c.classification?.class
  if (klass) scores.appendChild(pill(klass, 'warm'))

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
