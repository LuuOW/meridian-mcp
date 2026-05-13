// Compact 3D molecular models for the HET codes helix uses.
//
// Each entry lists atoms (element + x/y/z in Angstroms) and bonds
// (pairs of atom indices). Coordinates are simplified ideal geometries
// — close enough to look like the real compound at thumbnail scale,
// not real PDB-ideal-coords.
//
// drawCompound() renders one model into a 2D canvas as ball-and-stick
// with Jmol-style atom colors, lambert shading, and Z-sorted draw
// order. Uses no WebGL contexts — small enough to render dozens.

// Jmol atom colors (CPK with HF additions).
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

// ── Ideal geometries (Å) for the compounds in the helix seed table.
// CO3, NAG, BMA, CIT use simplified topology — visually correct,
// chemically close-enough for thumbnail rendering.
export const COMPOUND_MODELS = {
  // Iron(III) — single atom.
  FE: {
    atoms: [{ el: 'Fe', x: 0, y: 0, z: 0 }],
    bonds: [],
  },
  // Zinc(II) — single atom.
  ZN: {
    atoms: [{ el: 'Zn', x: 0, y: 0, z: 0 }],
    bonds: [],
  },
  // Carbonate CO3²⁻ — planar trigonal.
  CO3: {
    atoms: [
      { el: 'C', x: 0,     y: 0,     z: 0 },
      { el: 'O', x: 1.28,  y: 0,     z: 0 },
      { el: 'O', x: -0.64, y: 1.11,  z: 0 },
      { el: 'O', x: -0.64, y: -1.11, z: 0 },
    ],
    bonds: [[0, 1], [0, 2], [0, 3]],
  },
  // N-acetylglucosamine (NAG) — simplified pyranose ring + N-acetyl.
  // 6-membered ring (5 C + 1 O) in chair conformation, with the OHs
  // and N-acetyl substituents.
  NAG: {
    atoms: [
      // pyranose ring (chair: alternate Z)
      { el: 'C', x:  1.25, y:  0.72, z:  0.18 },  // C1
      { el: 'C', x:  1.25, y: -0.72, z: -0.18 },  // C2
      { el: 'C', x:  0,    y: -1.44, z:  0.18 },  // C3
      { el: 'C', x: -1.25, y: -0.72, z: -0.18 },  // C4
      { el: 'C', x: -1.25, y:  0.72, z:  0.18 },  // C5
      { el: 'O', x:  0,    y:  1.44, z: -0.18 },  // O5 (ring O)
      // substituents
      { el: 'O', x:  2.45, y:  1.42, z: -0.30 },  // O1 (anomeric)
      { el: 'N', x:  2.45, y: -1.42, z:  0.45 },  // N (acetylamine)
      { el: 'O', x:  0,    y: -2.85, z: -0.45 },  // O3
      { el: 'O', x: -2.45, y: -1.42, z:  0.45 },  // O4
      { el: 'C', x: -2.45, y:  1.42, z: -0.30 },  // C6
      { el: 'O', x: -3.65, y:  0.7,  z:  0.0 },   // O6
      // acetyl
      { el: 'C', x:  3.7,  y: -0.7,  z:  0.0 },   // C=O
      { el: 'O', x:  3.7,  y:  0.55, z: -0.3 },   // =O
      { el: 'C', x:  4.9,  y: -1.4,  z:  0.3 },   // CH3
    ],
    bonds: [
      [0,1],[1,2],[2,3],[3,4],[4,5],[5,0],   // ring
      [0,6],[1,7],[2,8],[3,9],[4,10],[10,11],
      [7,12],[12,13],[12,14],
    ],
  },
  // β-D-mannose (BMA) — same pyranose skeleton, simpler substituents.
  BMA: {
    atoms: [
      { el: 'C', x:  1.25, y:  0.72, z:  0.18 },
      { el: 'C', x:  1.25, y: -0.72, z: -0.18 },
      { el: 'C', x:  0,    y: -1.44, z:  0.18 },
      { el: 'C', x: -1.25, y: -0.72, z: -0.18 },
      { el: 'C', x: -1.25, y:  0.72, z:  0.18 },
      { el: 'O', x:  0,    y:  1.44, z: -0.18 },
      { el: 'O', x:  2.45, y:  1.42, z: -0.30 },
      { el: 'O', x:  2.45, y: -1.42, z:  0.45 },
      { el: 'O', x:  0,    y: -2.85, z: -0.45 },
      { el: 'O', x: -2.45, y: -1.42, z:  0.45 },
      { el: 'C', x: -2.45, y:  1.42, z: -0.30 },
      { el: 'O', x: -3.65, y:  0.7,  z:  0.0 },
    ],
    bonds: [
      [0,1],[1,2],[2,3],[3,4],[4,5],[5,0],
      [0,6],[1,7],[2,8],[3,9],[4,10],[10,11],
    ],
  },
  // Citrate (CIT) — branched tricarboxylic acid (HO-C central with
  // CH₂-COOH on each side and -COOH on the central C).
  CIT: {
    atoms: [
      // central
      { el: 'C', x:  0,    y:  0,    z:  0 },     // C3 (central, with OH)
      { el: 'O', x:  0,    y:  1.5,  z:  0 },     // -OH
      // central -COOH
      { el: 'C', x:  0,    y: -1.5,  z:  0 },     // C(=O)
      { el: 'O', x:  1.2,  y: -2.1,  z:  0 },     // =O
      { el: 'O', x: -1.2,  y: -2.1,  z:  0 },     // -OH
      // arm 1
      { el: 'C', x:  1.5,  y:  0.5,  z:  0 },     // CH2
      { el: 'C', x:  3.0,  y:  0,    z:  0 },     // C(=O)
      { el: 'O', x:  4.0,  y:  0.8,  z:  0 },     // =O
      { el: 'O', x:  3.2,  y: -1.25, z:  0 },     // -OH
      // arm 2
      { el: 'C', x: -1.5,  y:  0.5,  z:  0 },
      { el: 'C', x: -3.0,  y:  0,    z:  0 },
      { el: 'O', x: -4.0,  y:  0.8,  z:  0 },
      { el: 'O', x: -3.2,  y: -1.25, z:  0 },
    ],
    bonds: [
      [0,1],[0,2],[2,3],[2,4],
      [0,5],[5,6],[6,7],[6,8],
      [0,9],[9,10],[10,11],[10,12],
    ],
  },
}

// Single-atom fallback for unknown HET codes (water, etc.).
const UNKNOWN_MODEL = { atoms: [{ el: 'C', x: 0, y: 0, z: 0 }], bonds: [] }

// ── 2D renderer ───────────────────────────────────────────────────────
// Projects atoms via simple orthographic (z used only for size + draw
// order), draws bonds as straight lines, atoms as radial-gradient
// shaded discs. Tight enough for 56×56 thumbnails.
export function drawCompound(canvas, hetCode) {
  const model = COMPOUND_MODELS[hetCode] || UNKNOWN_MODEL
  const dpr = window.devicePixelRatio || 1
  const w = canvas.width  = canvas.clientWidth * dpr
  const h = canvas.height = canvas.clientHeight * dpr
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  // Fit bounding box of atoms into canvas with padding.
  const xs = model.atoms.map(a => a.x), ys = model.atoms.map(a => a.y)
  const minX = Math.min(...xs, 0), maxX = Math.max(...xs, 0)
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 0)
  const span = Math.max(maxX - minX, maxY - minY, 2)
  const padding = w * 0.16
  const scale = (w - padding * 2) / span
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const project = (a) => ({
    px: w / 2 + (a.x - cx) * scale,
    // canvas Y is inverted vs. chem Y
    py: h / 2 - (a.y - cy) * scale,
    pr: (ATOM_RADIUS[a.el] || 0.6) * scale * 0.55,
    z: a.z || 0,
    el: a.el,
  })
  const projected = model.atoms.map(project)

  // 1. Bonds first — drawn as 2-tone lines.
  ctx.lineCap = 'round'
  for (const [i, j] of model.bonds) {
    const a = projected[i], b = projected[j]
    const grad = ctx.createLinearGradient(a.px, a.py, b.px, b.py)
    grad.addColorStop(0, ATOM_COLOR[a.el] || '#999')
    grad.addColorStop(1, ATOM_COLOR[b.el] || '#999')
    ctx.strokeStyle = grad
    ctx.lineWidth   = Math.max(1, scale * 0.10)
    ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke()
  }

  // 2. Atoms — sorted back-to-front by z, drawn with radial-gradient
  //    spheres for a hint of 3D depth.
  const order = projected.map((_, k) => k).sort((a, b) => projected[a].z - projected[b].z)
  for (const k of order) {
    const a = projected[k]
    const base = ATOM_COLOR[a.el] || '#888'
    const r = Math.max(a.pr, 2)
    const grad = ctx.createRadialGradient(
      a.px - r * 0.35, a.py - r * 0.35, r * 0.15,
      a.px,            a.py,            r
    )
    grad.addColorStop(0, lighten(base, 0.55))
    grad.addColorStop(0.6, base)
    grad.addColorStop(1, darken(base, 0.5))
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(a.px, a.py, r, 0, Math.PI * 2); ctx.fill()
    // subtle rim
    ctx.strokeStyle = darken(base, 0.7)
    ctx.lineWidth = Math.max(0.5, r * 0.06)
    ctx.stroke()
  }

  // Element label for single-atom compounds (Fe, Zn) — drawn in the
  // center so the viewer reads the symbol at a glance.
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
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `rgb(${r},${g},${bl})`
}
function parseHex(h) {
  const s = h.startsWith('#') ? h.slice(1) : h
  const n = s.length === 3
    ? s.split('').map(c => parseInt(c + c, 16))
    : [parseInt(s.slice(0,2),16), parseInt(s.slice(2,4),16), parseInt(s.slice(4,6),16)]
  return n
}
