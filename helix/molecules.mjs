// Live extraction of compound coordinates from a fetched PDB.
//
// The PDB file we hand to Mol* for the protein render already contains
// every ligand and cofactor at experimentally-determined positions —
// the HETATM records. Parsing the same text twice (once for Mol*,
// once for our compound thumbnails) avoids an extra fetch AND gives
// us real geometry per structure instead of idealized lookups.
//
// drawCompound() renders one compound into a 2D canvas as ball-and-stick
// with Jmol atom colors, lambert-shaded spheres, and Z-sorted draw
// order. Uses no WebGL contexts.

// Jmol-style CPK colors (with HF additions).
const ATOM_COLOR = {
  H:  '#dddddd', C:  '#3b3b3b', N:  '#3050f8', O:  '#cc0000',
  S:  '#f8c000', P:  '#ff8000', F:  '#90e050',
  Fe: '#e06633', Zn: '#7d80b0', Ca: '#3dff00', Mg: '#8aff00',
  Mn: '#9c7ac7', Cu: '#c88033', Na: '#ab5cf2', K:  '#8f40d4',
}
const ATOM_RADIUS = {
  H: 0.32, C: 0.55, N: 0.55, O: 0.55, S: 0.7, P: 0.7, F: 0.5,
  Fe: 0.9, Zn: 0.85, Ca: 1.0, Mg: 0.9, Mn: 0.9, Cu: 0.85, Na: 1.0, K: 1.1,
}

// HET codes that are almost always crystallographic noise, not biology.
// Tight list — keeps SO4/CIT/NAG (which can be real binders) in scope.
const HET_DENYLIST = new Set([
  'HOH',                                                     // water
  'GOL', 'EDO', 'PEG', 'PG4', 'PGE', 'P6G', 'MPD',           // cryoprotectants
  'BME', 'DMS', 'DMF', 'IMD', 'IPA',                         // solvents
  'ACT', 'FMT', 'MES', 'EPE', 'TRS', 'BU3', 'TLA',           // buffers
])

// Friendly labels for codes we know; falls back to the 3-letter code.
const HET_LABEL = {
  FE:  'iron',         ZN:  'zinc',          CA:  'calcium',     MG:  'magnesium',
  MN:  'manganese',    CU:  'copper',        NA:  'sodium',      K:   'potassium',
  NAG: 'NAG (glycan)', BMA: 'mannose',       GAL: 'galactose',   FUC: 'fucose',
  MAN: 'mannose',      NDG: 'GlcNAc',        SIA: 'sialic acid',
  HEM: 'heme',         HEC: 'heme C',        FAD: 'FAD',         NAD: 'NAD',
  CO3: 'carbonate',    SO4: 'sulfate',       PO4: 'phosphate',   CIT: 'citrate',
  ATP: 'ATP',          ADP: 'ADP',           AMP: 'AMP',         GTP: 'GTP',
}

export function labelFor(code) { return HET_LABEL[code] || code }

// Parse HETATM records out of a PDB text. Returns one entry per unique
// HET code (deduped — many structures contain repeated instances; we
// show one representative). Atoms are centered on the residue centroid
// so the renderer sees coords near origin. Bonds are derived by
// distance threshold (1.9 Å covalent) — fast, robust, doesn't need
// CONECT records which many PDBs omit for organics.
export function parseHETsFromPdb(pdbText, { maxPerStructure = 6, skipHydrogens = true } = {}) {
  const residues = new Map()   // chain:resSeq:resName → { code, atoms[] }

  for (const line of pdbText.split('\n')) {
    if (!line.startsWith('HETATM')) continue
    const resName = line.slice(17, 20).trim()
    if (HET_DENYLIST.has(resName)) continue

    // Element field (cols 77-78) is optional; fall back to deriving
    // from the atom-name column.
    let element = line.slice(76, 78).trim()
    if (!element) {
      element = line.slice(12, 16).trim().replace(/\d/g, '').slice(0, 2)
    }
    element = (element[0] || '').toUpperCase() + (element.slice(1).toLowerCase() || '')
    if (skipHydrogens && element === 'H') continue

    const chain  = line.slice(21, 22)
    const resSeq = parseInt(line.slice(22, 26), 10)
    const key = `${chain}:${resSeq}:${resName}`

    if (!residues.has(key)) residues.set(key, { code: resName, atoms: [] })
    residues.get(key).atoms.push({
      el: element,
      x:  parseFloat(line.slice(30, 38)),
      y:  parseFloat(line.slice(38, 46)),
      z:  parseFloat(line.slice(46, 54)),
    })
  }

  const unique = new Map()
  for (const r of residues.values()) {
    if (unique.has(r.code)) continue                          // first instance per code
    if (r.atoms.length === 0) continue
    // Center on centroid so the 2D renderer doesn't have to.
    const cx = mean(r.atoms.map(a => a.x))
    const cy = mean(r.atoms.map(a => a.y))
    const cz = mean(r.atoms.map(a => a.z))
    const atoms = r.atoms.map(a => ({ el: a.el, x: a.x - cx, y: a.y - cy, z: a.z - cz }))
    const bonds = bondsByDistance(atoms, 1.95)
    unique.set(r.code, {
      code:  r.code,
      label: HET_LABEL[r.code] || r.code,
      atoms,
      bonds,
    })
    if (unique.size >= maxPerStructure) break
  }
  return [...unique.values()]
}

function bondsByDistance(atoms, threshold) {
  const out = []
  const t2 = threshold * threshold
  for (let i = 0; i < atoms.length; i++) {
    for (let j = i + 1; j < atoms.length; j++) {
      const dx = atoms[i].x - atoms[j].x
      const dy = atoms[i].y - atoms[j].y
      const dz = atoms[i].z - atoms[j].z
      if (dx*dx + dy*dy + dz*dz < t2) out.push([i, j])
    }
  }
  return out
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }

// ── 2D renderer ───────────────────────────────────────────────────────
// Project atoms via orthographic (z used for size+order), bonds as
// 2-tone gradient lines, atoms as radial-gradient shaded discs.
// Accepts either a parsed { atoms, bonds, code } model or a HET code
// (legacy — falls back to a single-atom placeholder).
export function drawCompound(canvas, modelOrCode) {
  const model = typeof modelOrCode === 'string'
    ? { code: modelOrCode, atoms: [{ el: 'C', x: 0, y: 0, z: 0 }], bonds: [] }
    : modelOrCode

  const dpr = window.devicePixelRatio || 1
  const w = canvas.width  = canvas.clientWidth  * dpr
  const h = canvas.height = canvas.clientHeight * dpr
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  if (!model.atoms.length) return

  // Fit bounding box.
  const xs = model.atoms.map(a => a.x), ys = model.atoms.map(a => a.y)
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0)
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0)
  const span = Math.max(maxX - minX, maxY - minY, 2)
  const padding = w * 0.18
  const scale = (w - padding * 2) / span
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2

  const projected = model.atoms.map(a => ({
    px: w / 2 + (a.x - cx) * scale,
    py: h / 2 - (a.y - cy) * scale,
    pr: (ATOM_RADIUS[a.el] || 0.6) * scale * 0.55,
    z: a.z || 0,
    el: a.el,
  }))

  // Bonds first.
  ctx.lineCap = 'round'
  for (const [i, j] of model.bonds) {
    const a = projected[i], b = projected[j]
    if (!a || !b) continue
    const grad = ctx.createLinearGradient(a.px, a.py, b.px, b.py)
    grad.addColorStop(0, ATOM_COLOR[a.el] || '#999')
    grad.addColorStop(1, ATOM_COLOR[b.el] || '#999')
    ctx.strokeStyle = grad
    ctx.lineWidth   = Math.max(1, scale * 0.10)
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
  }

  // Atoms back-to-front.
  const order = projected.map((_, k) => k).sort((a, b) => projected[a].z - projected[b].z)
  for (const k of order) {
    const a = projected[k]
    const base = ATOM_COLOR[a.el] || '#888'
    const r = Math.max(a.pr, 2)
    const grad = ctx.createRadialGradient(
      a.px - r * 0.35, a.py - r * 0.35, r * 0.15,
      a.px,            a.py,            r
    )
    grad.addColorStop(0,   lighten(base, 0.55))
    grad.addColorStop(0.6, base)
    grad.addColorStop(1,   darken(base, 0.5))
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(a.px, a.py, r, 0, Math.PI * 2); ctx.fill()
    ctx.strokeStyle = darken(base, 0.7)
    ctx.lineWidth = Math.max(0.5, r * 0.06)
    ctx.stroke()
  }

  // Element label for single-atom compounds.
  if (model.atoms.length === 1) {
    const a = projected[0]
    ctx.fillStyle = '#0c0c12'
    ctx.font = `${Math.round(a.pr * 0.95)}px -apple-system, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(a.el, a.px, a.py + a.pr * 0.05)
  }
}

function lighten(hex, t) { return mix(hex, '#ffffff', t) }
function darken(hex, t)  { return mix(hex, '#000000', t) }
function mix(a, b, t) {
  const [ar, ag, ab] = parseHex(a), [br, bg, bb] = parseHex(b)
  return `rgb(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)})`
}
function parseHex(h) {
  const s = h.startsWith('#') ? h.slice(1) : h
  if (s.length === 3) return s.split('').map(c => parseInt(c + c, 16))
  return [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)]
}
