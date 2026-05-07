#!/usr/bin/env node
// Spectral-classifier simulation. Does NOT modify production code.
//
// Reframes each skill as a *light spectrum* over the visible band
// instead of a 7-axis hand-tuned signature, then classifies by best-
// fit against six prototype spectra. Grounded in Sears & Zemansky
// Vol. 2 (Young & Freedman) chapters 32–38: EM waves, polarization,
// Stefan-Boltzmann (I ∝ T⁴), Wien's displacement law, emission/
// absorption spectra, Doppler broadening, coherence.
//
// The hypothesis we're testing: Vallado's CRTBP couldn't classify
// because skills don't have a gravitational field. Light has no such
// requirement — a photon is a self-contained object whose intrinsic
// state lives in (λ, I, polarization, phase, coherence, spectrum)
// simultaneously, all independent. Encoding skills as spectra and
// classifying by *spectral shape* is the same way astronomy
// classifies stars (O / B / A / F / G / K / M) and asteroids (S /
// C / X-type) — by spectroscopic features, not by orbits.
//
// Encoding (text → spectrum)
// ──────────────────────────
//   • 32 bins across 380–750 nm (~11.6 nm/bin).
//   • Each token in {description, body, keywords} that hits a
//     SYSTEM_TERMS bucket emits a Gaussian "emission line" centred at
//     that domain's wavelength (forge → 480 nm cyan, signal → 425 nm
//     violet, mind → 620 nm amber). Sigma = 12 nm baseline,
//     broadened by drag and cross_domain (Doppler-like).
//   • Body length sets the continuum baseline (Stefan-Boltzmann
//     analog: I ∝ massT⁴ → modest pedestal under all bins).
//
// Prototypes (six classes, parameterised by the skill's dominant
// domain so prototypes are skill-specific spectra)
// ──────────────────────────────────────────────────────────
//   • planet     — broad Gaussian, FWHM ≈ 100 nm, peak ≈ 1.0
//                  (blackbody-like; G-type star)
//   • asteroid   — narrow Gaussian, FWHM ≈ 25 nm, peak ≈ 0.5
//                  (narrow-line emission; S/C-type asteroid analog)
//   • comet      — wide smear, FWHM ≈ 180 nm, peak ≈ 0.3
//                  (Doppler-broadened by drag × cross_domain)
//   • moon       — narrow Gaussian at parent's dominant λ, peak ≈ 0.45
//                  (reflected/derivative spectrum)
//   • trojan     — narrow Gaussian at parent's dominant λ + 30 nm
//                  offset (phase-shifted; same domain but distinct line)
//   • irregular  — bimodal: two narrow Gaussians at non-adjacent
//                  domain wavelengths (cross-domain emission nebula)
//
// Class assignment = max cosine similarity over the six prototypes.
// Soft membership available (top-1 + ratio to top-2) but for the
// dry-run we report the top-1 class.
//
// Run: node scripts/simulate-classifier-spectral.mjs

import { tokenize, uniq }                from '../mcp/_lib/tokenize.mjs'
import { SYSTEM_TERMS }                   from '../mcp/_lib/systems.mjs'
import { orbitalClassify as classifyV1 }  from '../mcp/_lib/orbital.mjs'
import { TASK, panelForClassify, PANEL }  from './calibration-panel.mjs'

// ── Spectrum constants ─────────────────────────────────────────────
const N_BINS    = 32
const LAMBDA_LO = 380
const LAMBDA_HI = 750
const BIN_W     = (LAMBDA_HI - LAMBDA_LO) / N_BINS
const LAMBDAS   = Array.from({ length: N_BINS }, (_, i) => LAMBDA_LO + (i + 0.5) * BIN_W)

// Domain → wavelength anchor. Picked from the existing Lens palette
// so the spectrum and the visualization agree.
//   forge  (devops/backend)   = cool cyan ~ 480 nm
//   signal (growth/marketing) = violet/magenta ~ 425 nm
//   mind   (AI/research)      = amber ~ 620 nm
const DOMAIN_LAMBDA = { forge: 480, signal: 425, mind: 620 }

// ── Helpers ────────────────────────────────────────────────────────
function clamp(v, lo = 0, hi = 1) { return v < lo ? lo : v > hi ? hi : v }

function gaussian(centre, sigma) {
  const out = new Float64Array(N_BINS)
  const inv2s2 = 1 / (2 * sigma * sigma)
  for (let i = 0; i < N_BINS; i++) {
    const dl = LAMBDAS[i] - centre
    out[i] = Math.exp(-dl * dl * inv2s2)
  }
  return out
}

function addInPlace(a, b, scale = 1) {
  for (let i = 0; i < N_BINS; i++) a[i] += b[i] * scale
}

function normaliseToUnitArea(spec) {
  let s = 0
  for (let i = 0; i < N_BINS; i++) s += spec[i]
  if (s <= 0) return spec
  const out = new Float64Array(N_BINS)
  for (let i = 0; i < N_BINS; i++) out[i] = spec[i] / s
  return out
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < N_BINS; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

// ── Encode a skill as a spectrum ───────────────────────────────────
function encodeSpectrum(skill, ctx = {}) {
  const desc = (skill.description || '').toLowerCase()
  const body = (skill.body || '').toLowerCase()
  const kws  = (skill.keywords || []).map(k => String(k).toLowerCase())
  const tokens = uniq(tokenize(`${desc} ${body} ${kws.join(' ')}`))

  // Per-domain hit counts.
  const hits = { forge: 0, signal: 0, mind: 0 }
  for (const t of tokens) {
    for (const [sys, terms] of Object.entries(SYSTEM_TERMS)) {
      if (terms.has(t)) { hits[sys]++; break }
    }
  }
  const totalHits = hits.forge + hits.signal + hits.mind || 1

  // Cross-domain (Shannon entropy across domains) → Doppler broadening.
  const probs = ['forge', 'signal', 'mind'].map(s => hits[s] / totalHits)
  const H = -probs.filter(p => p > 0).reduce((s, p) => s + p * Math.log(p), 0)
  const cross_domain = clamp(H / Math.log(3))

  // Drag — long words / hyphenated terms (compound concepts → spectral broadening)
  const longWords = kws.filter(k => k.includes('-') || k.length >= 12).length
  const drag = clamp(longWords / Math.max(2, kws.length) * 0.7 + cross_domain * 0.2)

  // Stefan-Boltzmann analog — body length → continuum amplitude.
  // I_continuum ∝ "T⁴" = (mass)⁴ where mass is in [0, 1].
  const BODY_LO = 200, BODY_HI = 3000
  const lenN = clamp(
    (Math.log10(Math.max(50, body.length)) - Math.log10(BODY_LO)) /
    (Math.log10(BODY_HI) - Math.log10(BODY_LO)),
  )
  const KW_LO = 3, KW_HI = 12
  const kwN  = clamp((kws.length - KW_LO) / (KW_HI - KW_LO))
  const mass = clamp(0.6 * lenN + 0.4 * kwN)
  const continuum = mass ** 4 * 0.15

  // Line broadening — base sigma 12 nm, broadened by drag + cross_domain.
  const sigma = 12 + 24 * (drag * 0.6 + cross_domain * 0.4)

  // Build spectrum: continuum baseline + emission line per domain hit.
  const spec = new Float64Array(N_BINS)
  for (let i = 0; i < N_BINS; i++) spec[i] = continuum
  for (const sys of ['forge', 'signal', 'mind']) {
    if (hits[sys] === 0) continue
    addInPlace(spec, gaussian(DOMAIN_LAMBDA[sys], sigma), hits[sys])
  }

  // Derived features.
  let peakI = 0, peakIdx = 0
  for (let i = 0; i < N_BINS; i++) {
    if (spec[i] > peakI) { peakI = spec[i]; peakIdx = i }
  }
  const peakLambda = LAMBDAS[peakIdx]
  let totalI = 0
  for (let i = 0; i < N_BINS; i++) totalI += spec[i]
  // FWHM: walk outward from peak until intensity ≤ peakI/2.
  const halfMax = peakI / 2
  let lo = peakIdx, hi = peakIdx
  while (lo > 0 && spec[lo] > halfMax) lo--
  while (hi < N_BINS - 1 && spec[hi] > halfMax) hi++
  const FWHM = (hi - lo) * BIN_W
  // Number of distinct peaks (local maxima above 60% of global peak).
  const peakThr = peakI * 0.60
  let nPeaks = 0
  for (let i = 1; i < N_BINS - 1; i++) {
    if (spec[i] > spec[i - 1] && spec[i] > spec[i + 1] && spec[i] > peakThr) nPeaks++
  }
  // Spectral entropy.
  const norm = normaliseToUnitArea(spec)
  let entropy = 0
  for (let i = 0; i < N_BINS; i++) if (norm[i] > 0) entropy -= norm[i] * Math.log(norm[i])
  entropy /= Math.log(N_BINS)   // normalise to [0, 1]

  // Dominant + secondary domain (used to build prototypes).
  const dominantDomain = ['forge', 'signal', 'mind']
    .reduce((a, b) => hits[a] >= hits[b] ? a : b)
  const sortedDomains = ['forge', 'signal', 'mind']
    .sort((a, b) => hits[b] - hits[a])
  const secondaryDomain = sortedDomains[1]

  return {
    spec,
    features: { peakLambda, FWHM, totalI, peakI, nPeaks, entropy, dominantDomain, secondaryDomain, mass, drag, cross_domain },
  }
}

// ── Prototype spectra (skill-specific: depend on dominant domain) ──
function prototypePlanet(domain) {
  // Broad Gaussian, FWHM ≈ 100 nm.
  const sigma = 100 / 2.355   // FWHM = 2.355 σ for Gaussian
  return gaussian(DOMAIN_LAMBDA[domain], sigma)
}
function prototypeAsteroid(domain) {
  // Narrow Gaussian, FWHM ≈ 25 nm.
  const sigma = 25 / 2.355
  return gaussian(DOMAIN_LAMBDA[domain], sigma)
}
function prototypeComet(domain) {
  // Doppler-broadened smear, FWHM ≈ 180 nm.
  const sigma = 180 / 2.355
  return gaussian(DOMAIN_LAMBDA[domain], sigma)
}
function prototypeMoon(domain) {
  // Narrow Gaussian at parent's domain — same shape as asteroid but
  // class assignment uses sibling correlation + lower amplitude as the
  // discriminator (handled in classifySpectral).
  const sigma = 25 / 2.355
  return gaussian(DOMAIN_LAMBDA[domain], sigma)
}
function prototypeTrojan(domain) {
  // Narrow Gaussian offset 30 nm from parent's domain (phase-shifted line).
  const sigma = 25 / 2.355
  return gaussian(DOMAIN_LAMBDA[domain] + 30, sigma)
}
function prototypeIrregular(domA, domB) {
  // Two narrow Gaussians at two non-equal domains.
  const sigma = 25 / 2.355
  const out = new Float64Array(N_BINS)
  addInPlace(out, gaussian(DOMAIN_LAMBDA[domA], sigma), 1)
  addInPlace(out, gaussian(DOMAIN_LAMBDA[domB] || DOMAIN_LAMBDA[domA], sigma), 0.7)
  return out
}

// ── Classify by best spectral fit + sibling correlation ────────────
function classifySpectral(skill, ctx, allEnc) {
  const f = ctx.features
  const sk_spec = normaliseToUnitArea(ctx.spec)

  // Find sibling spectrum with highest cosine similarity.
  let bestSibCorr = 0, bestSib = null
  for (const other of allEnc) {
    if (other.skill === skill) continue
    const c = cosine(sk_spec, normaliseToUnitArea(other.ctx.spec))
    if (c > bestSibCorr) { bestSibCorr = c; bestSib = other }
  }

  // Build six prototypes and score by cosine similarity.
  const protos = {
    planet:    normaliseToUnitArea(prototypePlanet(f.dominantDomain)),
    asteroid:  normaliseToUnitArea(prototypeAsteroid(f.dominantDomain)),
    comet:     normaliseToUnitArea(prototypeComet(f.dominantDomain)),
    moon:      normaliseToUnitArea(prototypeMoon(f.dominantDomain)),
    trojan:    normaliseToUnitArea(prototypeTrojan(f.dominantDomain)),
    irregular: normaliseToUnitArea(prototypeIrregular(f.dominantDomain, f.secondaryDomain)),
  }
  const scores = {}
  for (const cls of Object.keys(protos)) scores[cls] = cosine(sk_spec, protos[cls])

  // Discriminate moon vs asteroid: both look narrow-Gaussian. The
  // tie-breaker is sibling correlation — moon shape *with high
  // sibling correlation* is reflected light. Above 0.85 corr →
  // upgrade asteroid to moon. Above 0.75 with a domain offset →
  // upgrade to trojan.
  if (bestSibCorr > 0.85 && f.totalI < ctx.medianI) {
    scores.moon += 0.15
  } else if (bestSibCorr > 0.75 && bestSib) {
    const myPeak  = f.peakLambda
    const sibPeak = bestSib.ctx.features.peakLambda
    if (Math.abs(myPeak - sibPeak) > 20) scores.trojan += 0.15
  }

  // Multi-modal override: irregular wins when there are genuinely
  // multiple peaks (cross-domain bridge).
  if (f.nPeaks >= 2 && f.entropy > 0.65) scores.irregular += 0.20

  // Find max.
  let best = -Infinity, cls = 'asteroid'
  for (const [k, v] of Object.entries(scores)) {
    if (v > best) { best = v; cls = k }
  }

  return { cls, scores, sibCorr: bestSibCorr, sibSlug: bestSib?.skill?.slug || null }
}

// ── Run pipeline ───────────────────────────────────────────────────
const panel = panelForClassify()
const v1 = classifyV1(panel, TASK)

const enc = panel.map(skill => ({ skill, ctx: encodeSpectrum(skill) }))
const totalIs = enc.map(e => e.ctx.features.totalI).sort((a, b) => a - b)
const medianI = totalIs[Math.floor(totalIs.length / 2)]
for (const e of enc) e.ctx.medianI = medianI
const spectral = enc.map(e => ({
  slug: e.skill.slug,
  ...classifySpectral(e.skill, e.ctx, enc),
  features: e.ctx.features,
}))

// ── Metrics ────────────────────────────────────────────────────────
const CLASSES = ['planet', 'moon', 'trojan', 'asteroid', 'comet', 'irregular']
function distOf(arr, getCls) {
  const d = {}
  for (const c of CLASSES) d[c] = 0
  for (const x of arr) d[getCls(x)] = (d[getCls(x)] || 0) + 1
  return d
}
const distV1 = distOf(v1, r => r.classification.class)
const distS  = distOf(spectral, r => r.cls)

let matchesV1 = 0, matchesS = 0
for (const r of v1) {
  const exp = PANEL.find(p => p.slug === r.slug)?.__expectedClass
  if (r.classification.class === exp) matchesV1++
}
for (const r of spectral) {
  const exp = PANEL.find(p => p.slug === r.slug)?.__expectedClass
  if (r.cls === exp) matchesS++
}
const accV1 = matchesV1 / v1.length
const accS  = matchesS / spectral.length

// ── Output ─────────────────────────────────────────────────────────
console.log(`\nSpectral classifier simulation (Sears & Zemansky Vol. 2 chs. 32–38)`)
console.log(`Bins: ${N_BINS} across ${LAMBDA_LO}–${LAMBDA_HI} nm`)
console.log(`Domain anchors: forge ${DOMAIN_LAMBDA.forge} nm · signal ${DOMAIN_LAMBDA.signal} nm · mind ${DOMAIN_LAMBDA.mind} nm`)
console.log(`Panel: ${panel.length} skills, task: "${TASK}"\n`)

console.log('CLASS DISTRIBUTION                CURRENT v1   →   SPECTRAL')
for (const cls of CLASSES) {
  const a = distV1[cls] || 0, b = distS[cls] || 0
  const arrow = a === b ? '·' : (b > a ? '↑' : '↓')
  console.log(`  ${cls.padEnd(12)}                ${String(a).padStart(3)}/${panel.length}  ${arrow}      ${String(b).padStart(3)}/${panel.length}`)
}

console.log(`\nCLASS ACCURACY                    ${accV1.toFixed(3)}        →   ${accS.toFixed(3)}`)
console.log(`(reference: pure v2 heuristic was 0.500; pure CRTBP was 0.222; v2+CRTBP was 0.389)`)

console.log('\nPER-SKILL SPECTRAL FIT')
console.log('  expected     →  spectral     features (peak λ / FWHM / nPeaks / entropy)')
for (let i = 0; i < panel.length; i++) {
  const r = spectral[i]
  const f = r.features
  const exp = PANEL[i].__expectedClass
  const ok = r.cls === exp ? '✓' : '·'
  console.log(`  ${ok}  ${panel[i].slug.padEnd(32)} ${exp.padEnd(11)} →  ${r.cls.padEnd(11)}  λ=${f.peakLambda.toFixed(0)} FWHM=${f.FWHM.toFixed(0)} np=${f.nPeaks} H=${f.entropy.toFixed(2)}  sib=${r.sibCorr.toFixed(2)} ${r.sibSlug ? `(${r.sibSlug})` : ''}`)
}

const flips = []
for (let i = 0; i < panel.length; i++) {
  const v1c = v1.find(r => r.slug === panel[i].slug)?.classification.class
  const sc  = spectral[i].cls
  if (v1c && v1c !== sc) {
    flips.push({ slug: panel[i].slug, from: v1c, to: sc, expected: PANEL[i].__expectedClass })
  }
}
if (flips.length) {
  console.log(`\nCLASS FLIPS  (${flips.length} of ${panel.length})`)
  for (const f of flips) {
    const correct = f.to === f.expected ? '✓' : (f.from === f.expected ? '✗' : '·')
    console.log(`  ${correct}  ${f.slug.padEnd(32)} ${f.from.padEnd(10)} → ${f.to.padEnd(10)}   (expected: ${f.expected})`)
  }
}

console.log('\nVERDICT')
const usedClasses = Object.values(distS).filter(n => n > 0).length
const max = Math.max(...Object.values(distS))
console.log(`  classes used                   : ${usedClasses}/6  ${usedClasses >= 4 ? '✓' : '✗'}`)
console.log(`  no class >50% of panel         : ${max <= panel.length * 0.5 ? '✓' : '✗'}  (max ${max}/${panel.length})`)
console.log(`  class accuracy ≥ 0.55          : ${accS >= 0.55 ? '✓' : '✗'}  (${accV1.toFixed(3)} → ${accS.toFixed(3)})`)
console.log(`  uses spectral physics          : ✓  (Stefan-Boltzmann continuum, Doppler-broadened lines, cosine prototype fit)`)
