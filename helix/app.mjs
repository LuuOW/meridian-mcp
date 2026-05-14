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

const API_BASE   = 'https://mcp.ask-meridian.uk'
const TIMEOUT_MS = 60_000

// Friendly labels for HET codes (ligands, cofactors, ions, glycans).
const HET_LABEL = {
  FE:  'iron',         ZN:  'zinc',          CA:  'calcium',     MG:  'magnesium',
  MN:  'manganese',    CU:  'copper',        NA:  'sodium',      K:   'potassium',
  CL:  'chloride',     BR:  'bromide',       IOD: 'iodide',      F:   'fluoride',
  NAG: 'NAG (glycan)', BMA: 'mannose',       GAL: 'galactose',   FUC: 'fucose',
  MAN: 'mannose',      NDG: 'GlcNAc',        SIA: 'sialic acid',
  HEM: 'heme',         HEC: 'heme C',        FAD: 'FAD',         NAD: 'NAD',
  CO3: 'carbonate',    SO4: 'sulfate',       PO4: 'phosphate',   CIT: 'citrate',
  ATP: 'ATP',          ADP: 'ADP',           AMP: 'AMP',         GTP: 'GTP',
  HOH: 'water',
}

// Standard amino acid 3-letter codes — anything not in here is treated
// as a HETATM ligand/cofactor for selection labelling.
const STANDARD_AA = new Set([
  'ALA','ARG','ASN','ASP','CYS','GLU','GLN','GLY','HIS','ILE',
  'LEU','LYS','MET','PHE','PRO','SER','THR','TRP','TYR','VAL',
  'MSE','PYL','SEC',
])

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

let lastResult = null
let lastCandidates = []
const systemViewers = new Map()   // pdb → Mol* Viewer
const pdbTextCache  = new Map()   // pdb → raw PDB text (for residue lookups)

// Wait for window.molstar to land — the UMD bundle attaches on
// DOMContentLoaded. Promise resolves the moment it's available.
// Lazy-load the 5 MB Mol* UMD bundle on first use instead of blocking
// initial paint with a synchronous <script> in <head>. We still expose
// the same `molstarReady()` Promise API so callers don't change.
//
// Lazy load avoids the bundle entirely when the user just lands on the
// gate page and never submits an injury. First-call awaits the inject;
// subsequent calls resolve immediately against `window.molstar`.
let _molstarLoadPromise = null
function molstarReady() {
  if (window.molstar?.Viewer) return Promise.resolve(window.molstar)
  if (!_molstarLoadPromise) {
    _molstarLoadPromise = new Promise((resolve, reject) => {
      // Pull the CSS in the same shot so the first viewer mount doesn't
      // FOUC while we wait for molstar.css.
      if (!document.querySelector('link[data-molstar-css]')) {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = 'https://cdn.jsdelivr.net/npm/molstar@4.7.0/build/viewer/molstar.css'
        link.dataset.molstarCss = '1'
        document.head.appendChild(link)
      }
      const s = document.createElement('script')
      s.src = 'https://cdn.jsdelivr.net/npm/molstar@4.7.0/build/viewer/molstar.js'
      s.async = true
      s.onload = () => {
        if (window.molstar?.Viewer) return resolve(window.molstar)
        // Mol* exposes itself synchronously on script execution, but
        // give it a tick in case the UMD wrapper is split across
        // microtasks. 80 × 50 ms = 4 s upper bound, same as before.
        let tries = 0
        const t = setInterval(() => {
          tries++
          if (window.molstar?.Viewer) { clearInterval(t); resolve(window.molstar) }
          else if (tries > 80) { clearInterval(t); reject(new Error('molstar bundle did not initialise')) }
        }, 50)
      }
      s.onerror = () => reject(new Error('molstar bundle failed to load (CDN unreachable?)'))
      document.head.appendChild(s)
    })
  }
  return _molstarLoadPromise
}

// Mount a Mol* viewer in `host` and load the PDB by id. The viewer
// shows protein cartoon + ligand ball-and-stick in the same canvas
// — zooming reveals the bound molecules + their atoms.
//
// `onSelect(info)` fires each time the user clicks an atom inside the
// viewport; info describes the clicked residue or ligand (compId,
// seqId, chain, atomName, element). Empty clicks (background) are
// suppressed so rotate/zoom interactions don't open the detail panel.
async function mountProteinViewer(host, pdbId, onSelect) {
  const [pdbText, mol] = await Promise.all([
    fetch(`https://files.rcsb.org/download/${pdbId}.pdb`).then(r => r.text()),
    molstarReady(),
  ])
  pdbTextCache.set(pdbId, pdbText)
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
  try {
    viewer.plugin.canvas3d?.setProps({
      transparentBackground: true,
      renderer: { backgroundColor: 0x000000 },
    })
  } catch (e) { /* non-fatal */ }
  await viewer.loadStructureFromData(pdbText, 'pdb')

  // Click-to-inspect: try multiple subscription paths because the UMD
  // bundle's interaction stream lives at different keys across Mol*
  // versions. Whichever fires, we extract via describeLoci.
  if (onSelect) {
    const handler = (evt) => {
      const loci = evt?.current?.loci ?? evt?.loci ?? evt
      const info = describeLoci(loci)
      if (info) onSelect(info)
    }
    const tryPaths = [
      () => viewer.plugin.behaviors?.interaction?.click,
      () => viewer.plugin.behaviors?.interaction?.selectionMode,
      () => viewer.plugin.canvas3d?.input?.click,
      () => viewer.plugin.managers?.interactivity?.click,
    ]
    for (const get of tryPaths) {
      try {
        const stream = get()
        if (stream?.subscribe) {
          stream.subscribe(handler)
          console.debug('[helix] click stream subscribed via', get.toString())
          break
        }
      } catch {}
    }
  }
}

// Extract a residue/atom description from a Mol* Loci. The UMD bundle
// doesn't expose StructureElement / StructureProperties on its
// namespace, so we walk the loci's `elements` array directly. The
// shape is documented at https://molstar.org/docs as
// { kind, structure, elements: [{ unit, indices }] }.
function describeLoci(loci) {
  if (!loci) {
    console.debug('[helix] click loci: null')
    return null
  }
  if (loci.kind === 'empty-loci') return null

  try {
    const els = loci.elements
    if (!Array.isArray(els) || !els.length) {
      console.debug('[helix] click loci: no elements', loci.kind, Object.keys(loci))
      return null
    }
    const el = els[0]
    const unit = el.unit
    if (!unit?.model?.atomicHierarchy) {
      console.debug('[helix] click loci: no atomicHierarchy on unit')
      return null
    }

    // The "indices" field is a Mol* SortedRanges/OrderedSet; the
    // public getter is .elements[0] in current versions.
    let atomIdx = null
    const idx = el.indices
    if (idx) {
      if (Array.isArray(idx?.elements)) atomIdx = idx.elements[0]
      else if (typeof idx.first === 'number') atomIdx = idx.first
      else if (typeof idx.offset === 'number') atomIdx = idx.offset
      else if (typeof idx[0] === 'number') atomIdx = idx[0]
    }
    // Last-ditch: pick the first atom of the unit.
    if (atomIdx == null && unit.elements) {
      atomIdx = Array.isArray(unit.elements) ? unit.elements[0] : unit.elements[0]
    }
    if (atomIdx == null) {
      console.debug('[helix] click loci: no atom index resolved')
      return null
    }

    const m = unit.model.atomicHierarchy
    const safe = (fn) => { try { return fn() } catch { return undefined } }

    const compId   = safe(() => m.atoms.label_comp_id.value(atomIdx))
    const atomName = safe(() => m.atoms.label_atom_id.value(atomIdx))
    const element  = safe(() => m.atoms.type_symbol.value(atomIdx))
    const residueIdx = safe(() => m.residueAtomSegments.index[atomIdx])
    const seqId    = residueIdx != null ? safe(() => m.residues.label_seq_id.value(residueIdx)) : undefined
    const chainIdx = safe(() => m.chainAtomSegments.index[atomIdx])
    const asymId   = chainIdx != null ? safe(() => m.chains.label_asym_id.value(chainIdx)) : undefined

    console.debug('[helix] click extracted:', { compId, atomName, element, seqId, asymId })
    if (!compId) return null
    const kind = STANDARD_AA.has(String(compId).toUpperCase()) ? 'residue' : 'ligand'
    return { kind, compId, atomName, element, seqId, asymId }
  } catch (e) {
    console.warn('[helix] describeLoci failed:', e?.message || e, e?.stack)
    return null
  }
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

    <div class="system-center ${c.pdb ? '' : 'empty'}">
      ${c.pdb ? `
        <div class="system-viewport"></div>
        <button class="viewer-tool fullscreen-btn" type="button" aria-label="Toggle fullscreen" title="Fullscreen (Esc to exit)">
          <svg class="ico-expand" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>
          </svg>
          <svg class="ico-collapse" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/>
          </svg>
        </button>
        <div class="system-hud">
          <div class="hud-name">${escapeHtml(c.name || '')} · ${escapeHtml(c.uniprot || '')}</div>
          <div class="hud-meta">${c.aa_len ?? '?'} aa · PDB ${escapeHtml(c.pdb || '—')}</div>
          <div class="hud-scores">
            ${c.llm_score   != null ? `<span class="score-pill">LLM ${c.llm_score}/100</span>` : ''}
            ${c.route_score != null ? `<span class="score-pill warm">orbital ${Number(c.route_score).toFixed(2)}</span>` : ''}
            ${c.classification?.class ? `<span class="score-pill dim">${escapeHtml(c.classification.class)}</span>` : ''}
          </div>
          <div class="hud-rationale">${escapeHtml(c.rationale || c.description || c.use || '')}</div>
          <div class="hud-selection" hidden>
            <div class="hud-sel-text"></div>
            <canvas class="hud-molecule" width="220" height="160"></canvas>
          </div>
        </div>
      ` : 'no PDB'}
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

  // Card click → open the detail panel with general protein info.
  // Drags don't fire a `click` (DOM only emits it for quick taps with
  // minimal movement), so rotate gestures inside the Mol* canvas stay
  // separate from this handler. Atom clicks ALSO fire Mol*'s
  // subscription below, which calls showDetail(c, sel) right after to
  // enrich the same panel with selection-specific info.
  card.addEventListener('click', () => showDetail(c))
  universe.appendChild(card)

  const centerEl   = card.querySelector('.system-center')
  const viewportEl = card.querySelector('.system-viewport')
  const fsBtn      = card.querySelector('.fullscreen-btn')
  if (fsBtn) {
    fsBtn.addEventListener('click', e => {
      e.stopPropagation()
      toggleFullscreen(centerEl)
    })
  }

  if (!c.pdb || !viewportEl) return

  // Mol* renders cartoon protein + ligand atoms in the same canvas;
  // zoom reveals the molecules inside the structure. The viewport
  // div is a sibling of the fullscreen button, so when Mol* takes
  // over its host on mount, the button stays untouched.
  //
  // On atom click: show in BOTH the side detail panel (visible in
  // normal view) AND the in-viewport HUD (visible while fullscreen,
  // since the side panel is outside the fullscreen tree).
  const onSelect = (sel) => {
    showDetail(c, sel)
    updateHud(centerEl, c, sel)
    explainSelection(c, sel, centerEl)
  }
  mountProteinViewer(viewportEl, c.pdb, onSelect).catch(e => {
    console.warn('mol*', c.pdb, 'failed:', e?.message || e)
    viewportEl.textContent = `PDB ${c.pdb} failed`
    viewportEl.style.display = 'flex'
    viewportEl.style.alignItems = 'center'
    viewportEl.style.justifyContent = 'center'
    viewportEl.style.color = 'var(--dim)'
    viewportEl.style.fontSize = '12px'
  })
}

// ── Fullscreen ───────────────────────────────────────────────────────
async function toggleFullscreen(el) {
  try {
    if (document.fullscreenElement === el) {
      await document.exitFullscreen()
    } else if (el.requestFullscreen) {
      await el.requestFullscreen()
    }
  } catch (e) {
    console.warn('fullscreen failed:', e?.message || e)
  }
}

// Mol* tracks element size via ResizeObserver but a manual nudge after
// the fullscreen transition guarantees the canvas re-fits without a
// momentary blank frame.
function resizeAllViewers() {
  for (const [, v] of systemViewers) {
    try {
      v.plugin?.handleResize?.()
      v.plugin?.canvas3d?.handleResize?.()
    } catch {}
  }
}
document.addEventListener('fullscreenchange',     resizeAllViewers)
document.addEventListener('webkitfullscreenchange', resizeAllViewers)

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

// ── LLM-explained selection (cached). Fires after the initial render
// of selection info so the panel + HUD show metadata immediately and
// the prose backfills when the worker responds. Keyed by
// (pdbId, asymId, seqId, compId) so repeat clicks are instant.
const explainCache = new Map()

async function explainSelection(c, sel, centerEl) {
  const key = `${c.pdb}:${sel.asymId || ''}:${sel.seqId || ''}:${sel.compId}`
  const panelTarget = document.querySelector('#detailSelection .sel-explanation')
  const hudTarget   = centerEl?.querySelector('.hud-sel-explanation')
  const setText = (text, cls = '') => {
    if (panelTarget) { panelTarget.textContent = text; panelTarget.className = 'sel-explanation' + (cls ? ' ' + cls : '') }
    if (hudTarget)   { hudTarget.textContent   = text; hudTarget.className   = 'hud-sel-explanation' + (cls ? ' ' + cls : '') }
  }

  if (explainCache.has(key)) {
    setText(explainCache.get(key))
    return
  }
  setText('Asking the model what this does here…', 'loading')

  try {
    const res = await fetch(API_BASE + '/v1/helix-explain', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({
        protein_name: c.name,
        uniprot:      c.uniprot,
        pdb:          c.pdb,
        selection:    sel,
      }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    const desc = String(j.description || '').trim()
    if (!desc) throw new Error('empty description')
    explainCache.set(key, desc)
    setText(desc)
  } catch (e) {
    setText(`Couldn't generate explanation: ${e.message}`, 'failed')
  }
}

// ── Parse a single residue out of cached PDB text + render its
// atoms+bonds as 2D ball-and-stick. Reused by the side detail panel
// AND the fullscreen HUD, so we draw real PDB coordinates of whatever
// the user just clicked — not a stylized icon.
const ATOM_COLOR = {
  H:'#dddddd', C:'#3b3b3b', N:'#3050f8', O:'#cc0000',
  S:'#f8c000', P:'#ff8000', F:'#90e050',
  Fe:'#e06633', Zn:'#7d80b0', Ca:'#3dff00', Mg:'#8aff00',
  Mn:'#9c7ac7', Cu:'#c88033', Na:'#ab5cf2', K:'#8f40d4', Cl:'#1ff01f',
}
const ATOM_RADIUS = {
  H:0.32, C:0.55, N:0.55, O:0.55, S:0.7, P:0.7, F:0.5,
  Fe:0.9, Zn:0.85, Ca:1.0, Mg:0.9, Mn:0.9, Cu:0.85, Na:1.0, K:1.1, Cl:0.75,
}

function parseResidueAtoms(pdbText, { asymId, seqId, compId }) {
  const atoms = []
  for (const line of pdbText.split('\n')) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue
    const lineChain = line.slice(21, 22)
    const lineSeq   = parseInt(line.slice(22, 26), 10)
    const lineComp  = line.slice(17, 20).trim()
    // Match by what we have — asymId or seqId may be undefined for ions
    if (asymId && lineChain !== asymId) continue
    if (seqId != null && lineSeq !== seqId) continue
    if (compId && lineComp !== compId) continue
    let el = line.slice(76, 78).trim()
    if (!el) el = line.slice(12, 16).trim().replace(/\d/g, '').slice(0, 2)
    el = (el[0] || '').toUpperCase() + (el.slice(1).toLowerCase() || '')
    if (el === 'H') continue
    atoms.push({
      el,
      x: parseFloat(line.slice(30, 38)),
      y: parseFloat(line.slice(38, 46)),
      z: parseFloat(line.slice(46, 54)),
    })
  }
  if (!atoms.length) return null
  const mean = a => a.reduce((s,v)=>s+v,0)/a.length
  const cx = mean(atoms.map(a => a.x))
  const cy = mean(atoms.map(a => a.y))
  const cz = mean(atoms.map(a => a.z))
  const centered = atoms.map(a => ({ el: a.el, x: a.x - cx, y: a.y - cy, z: a.z - cz }))
  const bonds = []
  for (let i = 0; i < centered.length; i++) {
    for (let j = i + 1; j < centered.length; j++) {
      const dx = centered[i].x - centered[j].x
      const dy = centered[i].y - centered[j].y
      const dz = centered[i].z - centered[j].z
      if (dx*dx + dy*dy + dz*dz < 3.8) bonds.push([i, j])  // ~1.95 Å
    }
  }
  return { atoms: centered, bonds }
}

function drawMolecule(canvas, model) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.width  = canvas.clientWidth  * dpr
  const h = canvas.height = canvas.clientHeight * dpr
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)
  if (!model || !model.atoms.length) return

  const xs = model.atoms.map(a => a.x), ys = model.atoms.map(a => a.y)
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2)
  const padding = Math.min(w, h) * 0.12
  const scale = (Math.min(w, h) - padding * 2) / span
  const projected = model.atoms.map(a => ({
    px: w / 2 + a.x * scale,
    py: h / 2 - a.y * scale,
    pr: (ATOM_RADIUS[a.el] || 0.6) * scale * 0.55,
    z:  a.z || 0,
    el: a.el,
  }))

  ctx.lineCap = 'round'
  for (const [i, j] of model.bonds) {
    const a = projected[i], b = projected[j]
    if (!a || !b) continue
    const g = ctx.createLinearGradient(a.px, a.py, b.px, b.py)
    g.addColorStop(0, ATOM_COLOR[a.el] || '#999')
    g.addColorStop(1, ATOM_COLOR[b.el] || '#999')
    ctx.strokeStyle = g
    ctx.lineWidth = Math.max(1, scale * 0.10)
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
  }
  const order = projected.map((_, k) => k).sort((a, b) => projected[a].z - projected[b].z)
  for (const k of order) {
    const a = projected[k]
    const base = ATOM_COLOR[a.el] || '#888'
    const r = Math.max(a.pr, 2)
    const g = ctx.createRadialGradient(a.px - r*0.35, a.py - r*0.35, r*0.15, a.px, a.py, r)
    g.addColorStop(0,   lighten(base, 0.55))
    g.addColorStop(0.6, base)
    g.addColorStop(1,   darken(base, 0.5))
    ctx.fillStyle = g
    ctx.beginPath(); ctx.arc(a.px, a.py, r, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = darken(base, 0.7)
    ctx.lineWidth = Math.max(0.5, r * 0.06)
    ctx.stroke()
  }
  // Element label inside single-atom compounds
  if (model.atoms.length === 1) {
    const a = projected[0]
    ctx.fillStyle = '#0c0c12'
    ctx.font = `${Math.round(a.pr * 0.95)}px -apple-system, system-ui, sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText(a.el, a.px, a.py + a.pr * 0.05)
  }
}
function lighten(hex, t) { return mix(hex, '#ffffff', t) }
function darken(hex, t)  { return mix(hex, '#000000', t) }
function mix(a, b, t) {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b)
  return `rgb(${Math.round(ar+(br-ar)*t)},${Math.round(ag+(bg-ag)*t)},${Math.round(ab+(bb-ab)*t)})`
}
function parseHex(h) {
  const s = h.startsWith('#') ? h.slice(1) : h
  if (s.length === 3) return s.split('').map(c => parseInt(c + c, 16))
  return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)]
}

// ── Detail panel — accepts an optional selection info from Mol* clicks.
// Order matters: unhide the panel BEFORE rendering, so the canvas
// inside the selection block has non-zero clientWidth/Height. With
// hidden=true on any ancestor, descendants compute to display:none
// and any layout-dependent drawing produces a blank 0×0 canvas.
function showDetail(c, sel = null) {
  detail.hidden = false

  $('detailTitle').textContent = `${c.name} · ${c.uniprot || c.slug}`
  // Citation links — UniProt and (when known) RCSB PDB. Turns the detail
  // panel from a pure visualisation into something you'd cite.
  const meta = $('detailMeta')
  meta.innerHTML = ''
  const sizeBit = document.createElement('span')
  sizeBit.textContent = `${c.aa_len ?? '?'} aa · `
  meta.appendChild(sizeBit)
  if (c.uniprot) {
    const u = document.createElement('a')
    u.href = `https://www.uniprot.org/uniprotkb/${encodeURIComponent(c.uniprot)}/entry`
    u.target = '_blank'; u.rel = 'noopener'
    u.textContent = `UniProt ${c.uniprot}`
    meta.appendChild(u)
  }
  if (c.pdb) {
    meta.appendChild(document.createTextNode(' · '))
    const p = document.createElement('a')
    p.href = `https://www.rcsb.org/structure/${encodeURIComponent(c.pdb)}`
    p.target = '_blank'; p.rel = 'noopener'
    p.textContent = `PDB ${c.pdb}`
    meta.appendChild(p)
  } else {
    meta.appendChild(document.createTextNode(' · PDB —'))
  }
  $('detailRationale').textContent = c.rationale || c.description || ''

  const scores = $('detailScores'); scores.innerHTML = ''
  if (c.llm_score   != null) scores.appendChild(pill(`LLM ${c.llm_score}/100`))
  if (c.route_score != null) scores.appendChild(pill(`orbital ${Number(c.route_score).toFixed(2)}`))
  if (c.classification?.class) scores.appendChild(pill(c.classification.class, 'warm'))

  let notes = `<div>${escapeHtml(c.notes || '')}</div>`
  if (c.delivery_concern) notes += `<div class="concern">⚠ delivery: ${escapeHtml(c.delivery_concern)}</div>`
  $('detailNotes').innerHTML = notes

  renderSelection(sel, c.pdb)
}

function renderSelection(sel, pdbId) {
  const box = $('detailSelection')
  if (!box) return
  if (!sel) { box.hidden = true; return }

  const friendly  = HET_LABEL[sel.compId] || sel.compId
  const kindLabel = sel.kind === 'ligand' ? 'Ligand / cofactor' : 'Residue'
  const seqPart   = sel.seqId   ? ` <span class="sel-num">${sel.seqId}</span>` : ''
  const chainPart = sel.asymId  ? ` <span class="sel-meta">chain ${escapeHtml(sel.asymId)}</span>` : ''
  const atomParts = []
  if (sel.atomName) atomParts.push(`atom <strong>${escapeHtml(sel.atomName)}</strong>`)
  if (sel.element)  atomParts.push(`element <strong>${escapeHtml(sel.element)}</strong>`)

  const text = box.querySelector('.sel-text')
  if (text) {
    text.innerHTML = `
      <div class="sel-kind">${kindLabel}</div>
      <div class="sel-comp">${escapeHtml(friendly)}${seqPart}${chainPart}</div>
      ${atomParts.length ? `<div class="sel-atom">${atomParts.join(' · ')}</div>` : ''}
      <div class="sel-explanation"></div>
    `
  }
  // Unhide the box BEFORE drawing the canvas — clientWidth/Height
  // need a non-hidden parent chain to compute.
  box.hidden = false
  const canvas = box.querySelector('canvas.sel-molecule')
  if (canvas && pdbId) {
    const pdbText = pdbTextCache.get(pdbId)
    if (pdbText) {
      const model = parseResidueAtoms(pdbText, sel)
      drawMolecule(canvas, model)
      canvas.style.display = model ? '' : 'none'
    }
  }
}

// In-viewport HUD shown while .system-center is fullscreen — the side
// detail panel is outside the fullscreen tree so the browser hides
// it. The HUD lives inside .system-center, follows the viewport into
// fullscreen, and carries the same content (protein metadata, scores,
// rationale, plus the click-to-select block with a real 3D render of
// the selected residue/ligand).
function updateHud(centerEl, c, sel) {
  const hud = centerEl?.querySelector?.('.system-hud')
  if (!hud) return
  const selBox = hud.querySelector('.hud-selection')
  if (!sel) { if (selBox) selBox.hidden = true; return }

  const friendly  = HET_LABEL[sel.compId] || sel.compId
  const kindLabel = sel.kind === 'ligand' ? 'Ligand / cofactor' : 'Residue'
  const seqPart   = sel.seqId  ? ` ${sel.seqId}` : ''
  const chainPart = sel.asymId ? ` · chain ${escapeHtml(sel.asymId)}` : ''
  const atomBits  = []
  if (sel.atomName) atomBits.push(`atom ${escapeHtml(sel.atomName)}`)
  if (sel.element)  atomBits.push(escapeHtml(sel.element))

  const text = selBox.querySelector('.hud-sel-text')
  if (text) {
    text.innerHTML = `
      <div class="hud-kind">${kindLabel}</div>
      <div class="hud-comp">${escapeHtml(friendly)}${seqPart}${chainPart}</div>
      ${atomBits.length ? `<div class="hud-atom">${atomBits.join(' · ')}</div>` : ''}
      <div class="hud-sel-explanation"></div>
    `
  }
  const canvas = selBox.querySelector('canvas.hud-molecule')
  if (canvas && c?.pdb) {
    const pdbText = pdbTextCache.get(c.pdb)
    if (pdbText) {
      const model = parseResidueAtoms(pdbText, sel)
      drawMolecule(canvas, model)
      canvas.style.display = model ? '' : 'none'
    }
  }
  selBox.hidden = false
}
detail.querySelector('.detail-close').addEventListener('click', () => {
  detail.hidden = true
  renderSelection(null)
})

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
