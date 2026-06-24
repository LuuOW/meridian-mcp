// Per-topic SVG archetype library. Each archetype returns the bottom-half
// schematic that lives inside the 1920x1080 banner. The header, footer,
// background gradient, and corner markers are added by renderBannerSvg().
//
// To add a new archetype:
//   1. Write a function (palette) => string returning <g>...</g> SVG markup
//      centred around translate(960, 720) with x in [-700, 700] and y in [-300, 300].
//   2. Add an entry to KEYWORDS below.

type Palette = { accent1: string; accent2: string; kicker: string; bg: string; ink: string }

const safe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// ── 1. Quantum circuit: qubit lines + H/Rz gates + CNOT entangler ──
function circuit(p: Palette): string {
  return `
  <g transform="translate(960, 720)">
    <!-- panel frame -->
    <rect x="-560" y="-220" width="1120" height="380" rx="14" fill="rgba(15,23,42,0.65)" stroke="${p.accent1}" stroke-opacity="0.35"/>
    <text x="-540" y="-190" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">QUANTUM CIRCUIT</text>

    <!-- 4 qubit lines -->
    ${[0, 1, 2, 3].map(i => `
      <line x1="-440" y1="${-90 + i*60}" x2="440" y2="${-90 + i*60}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.4"/>
    `).join("")}

    <!-- H gates -->
    ${[0, 1, 2, 3].map(i => `
      <g transform="translate(-380, ${-90 + i*60})">
        <rect x="-18" y="-18" width="36" height="36" rx="4" fill="${p.accent1}" stroke="${p.accent1}"/>
        <text y="6" font-family="sans-serif" font-size="18" font-weight="bold" fill="#0a1625" text-anchor="middle">H</text>
      </g>
    `).join("")}

    <!-- Rz gates with parameter slots -->
    ${[0, 1, 2, 3].map(i => `
      <g transform="translate(-220, ${-90 + i*60})" filter="url(#glow)">
        <rect x="-44" y="-22" width="88" height="44" rx="6" fill="${p.accent2}" stroke="${p.accent2}"/>
        <text y="6" font-family="monospace" font-size="14" font-weight="bold" fill="#0a1625" text-anchor="middle">R$_z$(θ$_${i+1}$)</text>
      </g>
    `).join("")}

    <!-- CNOT block -->
    <g transform="translate(0, 0)">
      <rect x="-50" y="-130" width="100" height="260" rx="8" fill="rgba(139,92,246,0.18)" stroke="#8b5cf6" stroke-width="1.5"/>
      <line x1="-40" y1="-90" x2="40" y2="-90" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1"/>
      <line x1="-40" y1="-30" x2="40" y2="-30" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1"/>
      <line x1="-40" y1="30" x2="40" y2="30" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1"/>
      <line x1="-40" y1="90" x2="40" y2="90" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1"/>
      <circle cx="0" cy="-90" r="6" fill="#0a1625" stroke="#ffffff" stroke-width="2"/>
      <line x1="0" y1="-84" x2="0" y2="84" stroke="#ffffff" stroke-width="2"/>
      <circle cx="0" cy="90" r="6" fill="#0a1625" stroke="#ffffff" stroke-width="2"/>
      <text x="0" y="160" font-family="sans-serif" font-size="13" fill="#c4b5fd" text-anchor="middle">CNOT LAYER</text>
    </g>

    <!-- Measurement icons -->
    ${[0, 1, 2, 3].map(i => `
      <g transform="translate(280, ${-90 + i*60})">
        <path d="M -16,-16 L 16,-16 L 16,16 L -16,16 Z" fill="none" stroke="${p.kicker}" stroke-width="1.6"/>
        <path d="M -10,16 A 12 12 0 0 0 10 16" fill="none" stroke="${p.kicker}" stroke-width="1.6"/>
        <line x1="0" y1="2" x2="0" y2="14" stroke="${p.kicker}" stroke-width="1.6"/>
      </g>
    `).join("")}

    <!-- Classical register lanes -->
    ${[0, 1, 2, 3].map(i => `
      <line x1="320" y1="${-90 + i*60}" x2="440" y2="${-90 + i*60}" stroke="${p.kicker}" stroke-opacity="0.4" stroke-dasharray="6,4" stroke-width="1.2"/>
    `).join("")}
  </g>`
}

// ── 2. Tensor network: nodes + bonds + bond-dim indicator ──
function tensor(p: Palette): string {
  const nodes = [-440, -200, 40, 280, 480]
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">TENSOR NETWORK</text>
    <rect x="-560" y="-200" width="1120" height="400" rx="14" fill="rgba(15,23,42,0.6)" stroke="${p.accent1}" stroke-opacity="0.25"/>

    <!-- horizontal bond between nodes with bond-dim χ in the middle -->
    <line x1="${nodes[0]}" y1="0" x2="${nodes[4]}" y2="0" stroke="${p.accent1}" stroke-width="3" filter="url(#glow)"/>
    <text x="20" y="-12" font-family="serif" font-size="22" fill="${p.accent1}" text-anchor="middle">χ</text>

    <!-- nodes -->
    ${nodes.map((x, i) => `
      <g transform="translate(${x}, 0)">
        <circle r="34" fill="${p.accent2}" stroke="#ffffff" stroke-width="2"/>
        <text y="8" font-family="sans-serif" font-size="22" font-weight="bold" fill="#ffffff" text-anchor="middle">T${i+1}</text>
        <!-- physical index legs up and down -->
        <line x1="-18" y1="-22" x2="-18" y2="-90" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>
        <line x1="18" y1="-22" x2="18" y2="-90" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>
        <line x1="-18" y1="22" x2="-18" y2="90" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>
        <line x1="18" y1="22" x2="18" y2="90" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.5"/>
        <!-- open legs (spectral indices) -->
        <line x1="0" y1="-34" x2="0" y2="-130" stroke="${p.kicker}" stroke-width="1.4"/>
        <line x1="0" y1="34" x2="0" y2="130" stroke="${p.kicker}" stroke-width="1.4"/>
      </g>
    `).join("")}

    <!-- vertical bond splitting T2 into T2a/T2b (decomposition indicator) -->
    <g transform="translate(40, 0)">
      <line x1="0" y1="-34" x2="0" y2="-100" stroke="${p.accent1}" stroke-width="2" stroke-dasharray="4,4"/>
      <line x1="0" y1="34" x2="0" y2="100" stroke="${p.accent1}" stroke-width="2" stroke-dasharray="4,4"/>
      <circle cx="0" cy="-110" r="8" fill="${p.kicker}"/>
      <circle cx="0" cy="110" r="8" fill="${p.kicker}"/>
    </g>

    <text x="-440" y="180" font-family="monospace" font-size="14" fill="#a0afb7">SVD / SPECTRAL DECOMPOSITION</text>
    <text x="280" y="180" font-family="monospace" font-size="14" fill="#a0afb7">BOND DIM χ</text>
  </g>`
}

// ── 3. Spectrum: rainbow bar with central glowing peak ──
function spectrum(p: Palette): string {
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">SPECTRUM</text>

    <!-- spectrum bar with rainbow gradient -->
    <rect x="-460" y="-30" width="920" height="60" rx="8" fill="url(#spectrumGrad)" opacity="0.9"/>
    <rect x="-460" y="-30" width="920" height="60" rx="8" fill="none" stroke="${p.accent1}" stroke-opacity="0.4"/>

    <!-- wavelength axis with tick marks -->
    <line x1="-460" y1="50" x2="460" y2="50" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1.5"/>
    ${[-400,-200,0,200,400].map(x => `
      <line x1="${x}" y1="50" x2="${x}" y2="58" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1.2"/>
      <text x="${x}" y="74" font-family="monospace" font-size="11" fill="#a0afb7" text-anchor="middle">${x===0?'λ₀':x>0?'+'+x/200+'Δ':x/200+'Δ'}</text>
    `).join("")}

    <!-- central peak (the emission line) -->
    <g filter="url(#glow)">
      <rect x="-30" y="-50" width="60" height="120" fill="${p.accent2}" opacity="0.85"/>
    </g>
    <circle cx="0" cy="0" r="22" fill="${p.accent2}">
      <animate attributeName="r" values="22;28;22" dur="3s" repeatCount="indefinite"/>
    </circle>

    <!-- secondary peaks -->
    <g opacity="0.7">
      <rect x="-280" y="-20" width="14" height="50" fill="${p.kicker}"/>
      <rect x="240" y="-30" width="22" height="60" fill="${p.kicker}"/>
    </g>

    <!-- baseline label -->
    <text x="-460" y="-50" font-family="monospace" font-size="13" fill="#a0afb7">INTENSITY (a.u.)</text>
    <text x="460" y="-50" font-family="monospace" font-size="13" fill="#a0afb7" text-anchor="end">λ (nm)</text>

    <!-- caption -->
    <text x="0" y="160" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">PRIMARY EMISSION @ λ₀ · FWHM Δλ</text>
  </g>`
}

// ── 4. Lattice: hex grid (photonic / crystal / atomic) ──
function lattice(p: Palette): string {
  const cells: string[] = []
  const cols = 9, rows = 7, r = 36
  const dx = r * Math.sqrt(3), dy = r * 1.5
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = (col - (cols-1)/2) * dx + (row % 2 ? dx/2 : 0)
      const y = (row - (rows-1)/2) * dy
      const isDefect = (col === 4 && row === 3)
      const fill = isDefect ? p.accent2 : "rgba(15,23,42,0.6)"
      const stroke = isDefect ? p.accent2 : "#ffffff"
      const op = isDefect ? 1 : 0.45
      // hex points
      const pts: string[] = []
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI/3) * k + Math.PI/6
        pts.push(`${(x + r*Math.cos(a)).toFixed(1)},${(y + r*Math.sin(a)).toFixed(1)}`)
      }
      cells.push(`<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${stroke}" stroke-opacity="${op}" stroke-width="${isDefect ? 2.5 : 1}"/>`)
      if (isDefect) {
        cells.push(`<circle cx="${x}" cy="${y}" r="8" fill="${p.kicker}"/>`)
        cells.push(`<text x="${x}" y="${y - 50}" font-family="monospace" font-size="11" fill="${p.kicker}" text-anchor="middle">DEFECT</text>`)
      }
    }
  }
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">LATTICE</text>
    ${cells.join("\n    ")}
    <text x="0" y="180" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">HEX LATTICE · DEFECT LOCALIZATION</text>
  </g>`
}

// ── 5. Potential: V(x) curve + barrier + wavefunction ψ(x) ──
function potential(p: Palette): string {
  // Build a piecewise potential curve
  const Vpath = "M -460,80 L -300,80 L -200,20 L -100,-80 L -20,20 L 80,80 L 200,80 L 300,40 L 460,80"
  // ψ(x): two lobes straddling the barrier (tunneling signature)
  const psiPath = "M -440,80 Q -360,80 -340,30 Q -320,-20 -260,-30 Q -200,-30 -180,20 Q -160,60 -100,80 L 60,80 Q 100,80 120,40 Q 140,0 180,-10 Q 240,-10 260,30 Q 280,70 360,80 L 460,80"
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">POTENTIAL + ψ</text>

    <!-- axes -->
    <line x1="-480" y1="80" x2="480" y2="80" stroke="#ffffff" stroke-opacity="0.7" stroke-width="1.5"/>
    <line x1="-480" y1="80" x2="-480" y2="-140" stroke="#ffffff" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="-500" y="-130" font-family="serif" font-style="italic" font-size="22" fill="#ffffff">V</text>
    <text x="490" y="100" font-family="serif" font-style="italic" font-size="22" fill="#ffffff">x</text>

    <!-- V(x) curve filled underneath -->
    <path d="${Vpath} L 460,80 L -460,80 Z" fill="${p.accent1}" fill-opacity="0.18"/>
    <path d="${Vpath}" stroke="${p.accent1}" stroke-width="3" fill="none" filter="url(#glow)"/>

    <!-- ψ(x) -->
    <path d="${psiPath}" stroke="${p.accent2}" stroke-width="2.5" fill="none" stroke-dasharray="6,4"/>
    <text x="-380" y="-50" font-family="serif" font-style="italic" font-size="20" fill="${p.accent2}">ψ(x)</text>

    <!-- barrier label -->
    <text x="-110" y="-100" font-family="monospace" font-size="13" fill="${p.kicker}" text-anchor="middle">BARRIER</text>
    <text x="-110" y="-86" font-family="monospace" font-size="11" fill="${p.kicker}" text-anchor="middle">ΔV</text>

    <!-- classical turning points -->
    <circle cx="-300" cy="80" r="3" fill="${p.kicker}"/>
    <circle cx="200" cy="80" r="3" fill="${p.kicker}"/>

    <!-- caption -->
    <text x="0" y="160" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">V(x) · ψ(x) · CLASSICAL ↔ TUNNELING</text>
  </g>`
}

// ── 6. Phase diagram: axes with shaded regions + boundary curve ──
function phaseDiagram(p: Palette): string {
  // 3 regions separated by curves
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">PHASE DIAGRAM</text>

    <!-- axes -->
    <line x1="-460" y1="160" x2="460" y2="160" stroke="#ffffff" stroke-opacity="0.7" stroke-width="1.5"/>
    <line x1="-460" y1="160" x2="-460" y2="-160" stroke="#ffffff" stroke-opacity="0.7" stroke-width="1.5"/>
    <text x="-490" y="-150" font-family="serif" font-style="italic" font-size="20" fill="#ffffff">J</text>
    <text x="470" y="175" font-family="serif" font-style="italic" font-size="20" fill="#ffffff">h</text>

    <!-- region A: paramagnetic (right) -->
    <path d="M -460,-160 L 460,-160 L 460,160 L 100,160 Q 60,80 80,0 Q 100,-80 60,-160 Z"
          fill="${p.accent1}" fill-opacity="0.18" stroke="${p.accent1}" stroke-opacity="0.5"/>
    <!-- region B: critical wedge -->
    <path d="M 100,160 Q 60,80 80,0 Q 100,-80 60,-160 L -100,-160 Q -120,-80 -100,0 Q -80,80 -100,160 Z"
          fill="${p.accent2}" fill-opacity="0.18" stroke="${p.accent2}" stroke-opacity="0.5"/>
    <!-- region C: trivial (left) -->
    <path d="M -100,160 L -460,160 L -460,-160 L -100,-160 Q -120,-80 -100,0 Q -80,80 -100,160 Z"
          fill="${p.kicker}" fill-opacity="0.12" stroke="${p.kicker}" stroke-opacity="0.4"/>

    <!-- region labels -->
    <text x="280" y="0" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">PARAMAGNETIC</text>
    <text x="0" y="0" font-family="monospace" font-size="14" fill="${p.accent2}" text-anchor="middle">CRITICAL</text>
    <text x="-280" y="0" font-family="monospace" font-size="14" fill="${p.kicker}" text-anchor="middle">TRIVIAL</text>

    <!-- critical point -->
    <g filter="url(#glow)">
      <circle cx="0" cy="0" r="10" fill="${p.accent2}"/>
    </g>
    <text x="14" y="-12" font-family="monospace" font-size="12" fill="${p.accent2}">CRITICAL POINT</text>

    <text x="0" y="195" font-family="monospace" font-size="13" fill="#a0afb7" text-anchor="middle">PHASE BOUNDARY · UNIVERSALITY CLASS</text>
  </g>`
}

// ── 7. Process flow: boxes connected by arrows ──
function flow(p: Palette): string {
  const steps = [
    { label: "PREPARE", sub: "|ψ⟩" },
    { label: "EVOLVE",  sub: "U(t)" },
    { label: "MEASURE", sub: "M" },
    { label: "FEEDBACK", sub: "FB" },
    { label: "CORRECT", sub: "→|ψ'⟩" },
  ]
  const w = 180, h = 80, gap = 40
  const totalW = steps.length * w + (steps.length - 1) * gap
  const x0 = -totalW / 2
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">PROCESS FLOW</text>
    ${steps.map((s, i) => {
      const x = x0 + i * (w + gap)
      const y = -40
      return `
      <g transform="translate(${x}, ${y})">
        <rect x="0" y="0" width="${w}" height="${h}" rx="10" fill="rgba(15,23,42,0.7)" stroke="${p.accent1}" stroke-width="1.5"/>
        <rect x="0" y="0" width="${w}" height="22" rx="10" fill="${p.accent1}" fill-opacity="0.25"/>
        <text x="${w/2}" y="16" font-family="monospace" font-size="11" fill="${p.accent1}" text-anchor="middle" letter-spacing="3">${i+1}</text>
        <text x="${w/2}" y="50" font-family="sans-serif" font-size="18" font-weight="bold" fill="#ffffff" text-anchor="middle">${s.label}</text>
        <text x="${w/2}" y="70" font-family="monospace" font-size="14" fill="${p.accent2}" text-anchor="middle">${s.sub}</text>
      </g>
      ${i < steps.length - 1 ? `<path d="M ${x+w}, ${y + h/2} L ${x+w+gap-8}, ${y + h/2}" stroke="${p.accent1}" stroke-width="2" fill="none"/>
                                  <polygon points="${x+w+gap-8},${y+h/2-6} ${x+w+gap},${y+h/2} ${x+w+gap-8},${y+h/2+6}" fill="${p.accent1}"/>` : ""}`
    }).join("")}
    <text x="0" y="100" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">PIPELINE · MEASUREMENT → FEEDFORWARD → CORRECTION</text>
  </g>`
}

// ── 8. Spheres / molecules: two 3D-looking spheres with bond ──
function molecules(p: Palette): string {
  const sphere = (cx: number, fill: string, label: string) => `
    <defs>
      <radialGradient id="grad-${label}" cx="35%" cy="35%" r="65%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.85"/>
        <stop offset="60%" stop-color="${fill}" stop-opacity="1"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.5"/>
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="0" r="120" fill="url(#grad-${label})" stroke="${fill}" stroke-width="2"/>
    <text x="${cx}" y="160" font-family="sans-serif" font-size="28" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>
  `
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">SYSTEM</text>
    <rect x="-560" y="-200" width="1120" height="380" rx="14" fill="rgba(15,23,42,0.6)" stroke="${p.accent1}" stroke-opacity="0.25"/>

    ${sphere(-220, p.accent2, "A")}
    ${sphere(220, p.accent1, "B")}

    <!-- bond between spheres with electron cloud -->
    <line x1="-100" y1="0" x2="100" y2="0" stroke="${p.kicker}" stroke-width="3" opacity="0.7"/>
    <ellipse cx="0" cy="0" rx="100" ry="22" fill="${p.kicker}" fill-opacity="0.15" stroke="${p.kicker}" stroke-opacity="0.4" stroke-dasharray="4,4"/>

    <!-- arrows indicating dynamics -->
    <g transform="translate(-360, -90)">
      <path d="M 0,0 L 0,40" stroke="${p.accent1}" stroke-width="2"/>
      <polygon points="-6,34 6,34 0,46" fill="${p.accent1}"/>
      <text x="0" y="-8" font-family="monospace" font-size="13" fill="${p.accent1}" text-anchor="middle">E₁</text>
    </g>
    <g transform="translate(360, -90)">
      <path d="M 0,0 L 0,40" stroke="${p.accent1}" stroke-width="2"/>
      <polygon points="-6,34 6,34 0,46" fill="${p.accent1}"/>
      <text x="0" y="-8" font-family="monospace" font-size="13" fill="${p.accent1}" text-anchor="middle">E₂</text>
    </g>
  </g>`
}

// ── 9. Default triangle + ray (fallback) ──
function triangle(p: Palette): string {
  return `
  <g transform="translate(960, 720)">
    <text x="-540" y="-220" font-family="monospace" font-size="14" fill="${p.accent1}" letter-spacing="2">SCHEMATIC</text>
    <path d="M 0,-280 L -340,100 L 340,100 Z" fill="none" stroke="${p.accent1}" stroke-width="2.5" opacity="0.5"/>
    <path d="M 0,-280 L 0,180 L -340,100" fill="none" stroke="${p.accent2}" stroke-width="2" opacity="0.4"/>
    <path d="M 0,-280 L 0,180 L 340,100" fill="none" stroke="${p.accent2}" stroke-width="2" opacity="0.4"/>

    <g stroke="#ffffff" stroke-width="3" opacity="0.85">
      <line x1="0" y1="0" x2="0" y2="-180"/>
      <line x1="0" y1="0" x2="-220" y2="80"/>
      <line x1="0" y1="0" x2="220" y2="80"/>
      <line x1="0" y1="0" x2="0" y2="120"/>
    </g>
    <circle cx="0" cy="0" r="18" fill="${p.kicker}">
      <animate attributeName="r" values="18;24;18" dur="3s" repeatCount="indefinite"/>
    </circle>

    <g transform="translate(0, -160)" filter="url(#glow)">
      <rect x="-300" y="-10" width="600" height="20" rx="10" fill="url(#spectrumGrad)" opacity="0.7"/>
    </g>

    <text x="0" y="200" font-family="monospace" font-size="14" fill="${p.accent1}" text-anchor="middle">GENERIC SCHEMATIC</text>
  </g>`
}

// ── Keyword → archetype mapping ──
const KEYWORDS: Array<{ archetype: (p: Palette) => string; matches: RegExp[] }> = [
  { archetype: circuit,        matches: [/circuit/i, /qubit/i, /\bqc\b/i, /gate/i, /\bhamiltonian\b/i, /ising/i, /state\s*prep/i, /qaoa/i, /vqe/i, /aqo/i, /adiabatic/i, /reichardt/i, /tunneling/i] },
  { archetype: tensor,         matches: [/\btensor\b/i, /\bmps\b/i, /\bmpo\b/i, /\bmera\b/i, /\bpeps\b/i, /matrix product/i, /kernel/i, /\bspectral tensor\b/i, /spectral decompos/i] },
  { archetype: spectrum,       matches: [/spectrum/i, /emission/i, /photolum/i, /\bpl\b/i, /\bzpls\b/i, /\bfwhm\b/i, /\bnmr\b/i, /\bepr\b/i, /\braman\b/i, /wavelength/i, /fluoresc/i, /colorim/i, /luminesc/i] },
  { archetype: lattice,        matches: [/lattice/i, /crystal/i, /\b2d\b/i, /\bhex\b/i, /graphene/i, /hbn/i, /boron nitride/i, /moiré/i, /photonic crystal/i, /cold atom/i, /atom array/i, /superlattice/i] },
  { archetype: potential,      matches: [/potential/i, /\bbarrier\b/i, /\btunneling\b/i, /tunnel/i, /\bwell\b/i, /\bground state\b/i, /schr[öo]dinger/i, /perturbat/i, /\bspectral gap\b/i, /adiabatic/i, /\bspike\b/i] },
  { archetype: phaseDiagram,   matches: [/\bphase\b/i, /\btransition\b/i, /\bcritical\b/i, /universality/i, /symmetry break/i, /\bhierarchy\b/i, /\btopolog/i, /altermagnet/i, /higher-order/i] },
  { archetype: flow,           matches: [/feed[- ]?forward/i, /\bmid[- ]?circuit\b/i, /process flow/i, /pipeline/i, /workflow/i, /protocol/i, /\bstep\b/i, /\bstage\b/i, /\bmeasure/i, /\breadout\b/i] },
  { archetype: molecules,      matches: [/molecule/i, /reaction/i, /\bbond\b/i, /\bcomplex\b/i, /\bparticle\b/i, /\bcolloid/i, /\btrapping\b/i, /\btrap\b/i, /\batom\b/i, /trapping/i, /\bstiffness\b/i] },
]

export function pickArchetype(texts: string[]): (p: Palette) => string {
  const joined = texts.join(" ").toLowerCase()
  let best: { archetype: (p: Palette) => string; hits: number } | null = null
  for (const k of KEYWORDS) {
    let hits = 0
    for (const re of k.matches) if (re.test(joined)) hits++
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { archetype: k.archetype, hits }
    }
  }
  return best ? best.archetype : triangle
}
