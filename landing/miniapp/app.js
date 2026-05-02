// /miniapp interactive demo
// Calls /api/orbital-route — fully dynamic: LLM generates skills,
// open-domain orbital classifier assigns celestial classes.
import { MiniGalaxy } from './mini-galaxy.js'
import { startAR, stopAR, unlockAR, isLocked } from './ar-mode.js'

// ── Burger menu (same UX as landing) ───────────────────────────────────
;(function () {
  const btn  = document.getElementById('burgerBtn')
  const menu = document.getElementById('navMenu')
  if (!btn || !menu) return
  const toggle = (open) => {
    const isOpen = open !== undefined ? open : !menu.classList.contains('open')
    menu.classList.toggle('open', isOpen)
    btn.classList.toggle('open', isOpen)
    btn.setAttribute('aria-expanded', String(isOpen))
    if (isOpen) {
      const first = menu.querySelector('a')
      if (first) setTimeout(() => first.focus(), 50)
    } else { btn.focus() }
  }
  btn.addEventListener('click', e => { e.stopPropagation(); toggle() })
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggle(false)))
  document.addEventListener('click', e => {
    if (!menu.classList.contains('open')) return
    if (!menu.contains(e.target) && !btn.contains(e.target)) toggle(false)
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false) })
})();

// ── Server-driven version badge — fetched from /api/version ───────────
fetch('/api/version', { cache: 'default' })
  .then(r => r.ok ? r.json() : null)
  .then(d => {
    if (!d?.npm) return
    const v = d.npm
    const navV = document.getElementById('versionBadge')
    if (navV) { navV.textContent = `MCP v${v}`; navV.removeAttribute('data-loading') }
  })
  .catch(() => {})

const $ = id => document.getElementById(id)
const taskInput      = $('taskInput')
const askBtn         = $('askBtn')
const arBtn          = $('arBtn')

// Defaults — controls were removed from the UI; routing is always
// fully dynamic: LLM generates the corpus, orbital engine classifies it.
const ROUTE_LIMIT = 5

const modelSelect = document.getElementById('modelSelect')
const quotaPill   = document.getElementById('quotaPill')

async function refreshQuota() {
  try {
    const r = await fetch('/api/quota')
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
    const txt = quotaPill.querySelector('.quota-text')
    const dot = quotaPill.querySelector('.quota-dot')
    if (d.plan === 'free') {
      txt.textContent = `Free · ${d.calls_today}/${d.daily_limit} today`
    } else {
      txt.textContent = `${d.plan[0].toUpperCase() + d.plan.slice(1)} · ${d.remaining}/${d.monthly_limit} this month`
    }
    quotaPill.removeAttribute('data-loading')
    const pct = d.pct_used ?? 0
    dot.style.background = pct >= 90 ? '#f87171' : pct >= 60 ? '#fbbf24' : '#10b981'
  } catch {
    quotaPill.querySelector('.quota-text').textContent = 'quota: offline'
    quotaPill.removeAttribute('data-loading')
  }
}
refreshQuota()
const resultsSection = $('resultsSection')
const resultsList    = $('resultsList')
const resultsMeta    = $('resultsMeta')
const miniGalaxyCanvas = $('miniGalaxyCanvas')
const mode2dBtn        = $('mode2d')
const mode3dBtn        = $('mode3d')
const arSection        = $('arSection')

// Side panel
const panel       = $('skillPanel')
const panelTitle  = $('skillPanelTitle')
const panelClass  = $('skillPanelClass')
const panelWhy    = $('skillPanelWhy')
const panelContent= $('skillPanelContent')
const panelClose  = $('skillPanelClose')
const panelBack   = $('skillPanelBackdrop')

// Stash latest results so the side panel has access to per-skill metadata
let latestSelected = []

// Single-flight guard for routing — prevents AR from queueing concurrent calls
// (each is ~45s and burns Workers AI neurons). Only ONE route call may be
// in flight at a time across the whole app.
let routingInFlight = false

const galaxy = new MiniGalaxy(miniGalaxyCanvas, {
  mode: '2d',
  onPlanetClick: slug => {
    const item = resultsList.querySelector(`[data-slug="${CSS.escape(slug)}"]`)
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' })
      item.style.boxShadow = '0 0 0 2px var(--neon-violet, #a78bfa), 0 0 24px rgba(167,139,250,0.45)'
      setTimeout(() => { item.style.boxShadow = '' }, 1200)
    }
    openPanel(slug)
  },
})

function setMode(m) {
  galaxy.setMode(m)
  mode2dBtn.classList.toggle('active', m === '2d')
  mode3dBtn.classList.toggle('active', m === '3d')
  mode2dBtn.setAttribute('aria-selected', m === '2d')
  mode3dBtn.setAttribute('aria-selected', m === '3d')
}
mode2dBtn.addEventListener('click', () => setMode('2d'))
mode3dBtn.addEventListener('click', () => setMode('3d'))

const escapeHTML = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))

document.querySelectorAll('.ex-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    taskInput.value = chip.dataset.task
    taskInput.focus()
  })
})

taskInput.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    askBtn.click()
  }
})

askBtn.addEventListener('click', async () => {
  if (routingInFlight) return  // already running — ignore further clicks
  const task = taskInput.value.trim()
  if (!task) {
    taskInput.focus()
    return
  }

  routingInFlight = true
  askBtn.disabled = true
  askBtn.setAttribute('aria-busy', 'true')
  askBtn.textContent = 'Generating skills…'
  resultsSection.hidden = false
  resultsList.setAttribute('aria-busy', 'true')
  requestAnimationFrame(() => galaxy._resize())
  resultsList.innerHTML =
    '<li class="no-results">' +
    '<span class="loading-pulse">🪐 Llama-3.3-70B is authoring SKILL specs…</span><br>' +
    '<small>then the orbital engine derives physics signatures and classifies each into a celestial class — planet · moon · trojan · asteroid · comet · irregular.<br><em>Workers AI: 40–50 s. Groq: 5–10 s.</em></small>' +
    '</li>'
  resultsMeta.textContent = ''
  closePanel()

  try {
    const data = await routeTask(task, ROUTE_LIMIT)
    renderResults(data)
  } catch (err) {
    resultsList.innerHTML = `<li class="no-results">Error: ${escapeHTML(err.message)}</li>`
    // On error, immediately re-arm AR so user can try again without
    // having to click rescan. Successful runs require an explicit click.
    if (arActive) unlockAR()
  } finally {
    askBtn.disabled = false
    askBtn.removeAttribute('aria-busy')
    askBtn.textContent = 'Find compatible skills →'
    resultsList.setAttribute('aria-busy', 'false')
    routingInFlight = false
    // If AR is open, surface the rescan affordance so the user can opt-in
    // to another query — never auto-queue.
    showRescanButton()
  }
})

async function routeTask(task, limit) {
  const provider = modelSelect?.value || 'workers-ai'
  const res = await fetch('/api/orbital-route', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ task, limit, provider }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  refreshQuota()       // sync the badge after a call lands
  return data
}

function renderResults(data) {
  latestSelected = data.selected || []
  galaxy.setSkills(latestSelected)

  let meta = `<span class="conf-${data.confidence}">${data.confidence}</span> · ` +
             `top <strong>${data.top_score.toFixed(1)}</strong> · ` +
             `${latestSelected.length}/${data.candidates_generated || latestSelected.length} skills`
  if (data.timing) {
    meta += ` · LLM ${data.timing.llm_ms} ms + classify ${data.timing.classify_ms} ms`
  }
  resultsMeta.innerHTML = meta

  if (!latestSelected.length) {
    resultsList.innerHTML = '<li class="no-results">No skills matched. Try different wording or one of the examples.</li>'
    return
  }

  resultsList.querySelectorAll('.result-item').forEach(el => el.replaceWith(el.cloneNode(true)))  // detach old listeners
  resultsList.innerHTML = latestSelected.map(s => {
    const cls = s.classification?.class || ''
    const sys = s.classification?.star_system || ''
    return `
    <li class="result-item" data-slug="${escapeHTML(s.slug)}">
      <div class="result-head">
        <span class="result-slug">${escapeHTML(s.slug)}</span>
        ${cls ? `<span class="result-class" data-class="${escapeHTML(cls)}">${escapeHTML(cls)}</span>` : ''}
        ${sys ? `<span class="result-system">${escapeHTML(sys)}</span>` : ''}
        <span class="result-score">${s.route_score.toFixed(1)}</span>
      </div>
      <p class="result-desc">${escapeHTML(s.description || '')}</p>
      <div class="result-why">${escapeHTML(s.why || '')}</div>
    </li>`
  }).join('')

  resultsList.querySelectorAll('.result-item').forEach(el => {
    el.addEventListener('click', () => openPanel(el.dataset.slug))
  })
}

// SIDE PANEL --------------------------------------------------------------
function openPanel(slug) {
  const skill = latestSelected.find(s => s.slug === slug)
  if (!skill) return

  panelTitle.textContent = skill.slug

  const cls = skill.classification?.class || ''
  panelClass.textContent = cls || ''
  panelClass.dataset.class = cls
  panelClass.style.display = cls ? 'inline-flex' : 'none'

  panelWhy.innerHTML  = renderWhy(skill)
  panelContent.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Loading skill…</p>'

  panel.hidden = false
  // tick to allow display change to apply before transition
  requestAnimationFrame(() => panel.setAttribute('aria-hidden', 'false'))
  document.body.style.overflow = 'hidden'

  // Body — for fully-dynamic skills, render the LLM-generated content directly
  panelContent.innerHTML = renderDynamicSkillBody(skill)
}

function closePanel() {
  panel.setAttribute('aria-hidden', 'true')
  document.body.style.overflow = ''
  setTimeout(() => { panel.hidden = true }, 320)
}
panelClose.addEventListener('click', closePanel)
panelBack.addEventListener('click',  closePanel)
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel() })

function renderWhy(skill) {
  const b   = skill.breakdown || {}
  const cls = skill.classification || {}
  const phys = cls.physics || {}

  const physBar = (label, val) => `
    <span class="label">${escapeHTML(label)}</span>
    <span class="bar"><span class="bar-fill phys" style="width:${(val * 100).toFixed(0)}%"></span></span>
    <span class="val">${val.toFixed(2)}</span>`

  // Wavelength (nm) → CSS rgb. Standard CIE-style approximation.
  const nmToRGB = (nm) => {
    let r = 0, g = 0, b = 0
    if      (nm >= 380 && nm < 440) { r = -(nm - 440) / 60; g = 0; b = 1 }
    else if (nm < 490)              { r = 0; g = (nm - 440) / 50; b = 1 }
    else if (nm < 510)              { r = 0; g = 1; b = -(nm - 510) / 20 }
    else if (nm < 580)              { r = (nm - 510) / 70; g = 1; b = 0 }
    else if (nm < 645)              { r = 1; g = -(nm - 645) / 65; b = 0 }
    else if (nm <= 750)             { r = 1; g = 0; b = 0 }
    return `rgb(${(r*255)|0},${(g*255)|0},${(b*255)|0})`
  }
  // Bar normaliser for non-[0,1] orbital values
  const orbitalBar = (label, val, max, unit, decimals = 2) => `
    <span class="label">${escapeHTML(label)}</span>
    <span class="bar"><span class="bar-fill phys" style="width:${(Math.min(val, max) / max * 100).toFixed(0)}%"></span></span>
    <span class="val">${val.toFixed(decimals)}${unit ? ' ' + unit : ''}</span>`

  const pills = []
  if (cls.parent)              pills.push(`<span class="meta-pill">parent <em>${escapeHTML(cls.parent)}</em></span>`)
  if (cls.star_system)         pills.push(`<span class="meta-pill">system <em>${escapeHTML(cls.star_system)}</em></span>`)
  if (cls.lagrange_systems?.length > 1)
    pills.push(`<span class="meta-pill">bridges <em>${cls.lagrange_systems.map(escapeHTML).join(' ↔ ')}</em></span>`)
  if (cls.lagrange_potential)
    pills.push(`<span class="meta-pill">L-potential <em>${cls.lagrange_potential.toFixed(2)}</em></span>`)
  if (cls.tidal_lock)          pills.push(`<span class="meta-pill" title="Always co-loads with parent">tidal-locked</span>`)
  if (cls.habitable_zone)      pills.push(`<span class="meta-pill" title="Stable activation profile">habitable-zone</span>`)
  if (b.class_mult > 1.01)     pills.push(`<span class="meta-pill">class boost <em>×${b.class_mult.toFixed(2)}</em></span>`)
  if (b.lagrange_mult > 1.01)  pills.push(`<span class="meta-pill">versatility <em>×${b.lagrange_mult.toFixed(2)}</em></span>`)
  if (b.diversity_mult > 1.01) pills.push(`<span class="meta-pill">diversity <em>×${b.diversity_mult.toFixed(2)}</em></span>`)

  const decisionRule = cls.decision_rule
    ? `<div class="decision-rule"><strong>Why this class:</strong> ${escapeHTML(cls.decision_rule)}</div>`
    : ''

  return `
    ${phys.orbital ? `
      <h4>Orbital dynamics</h4>
      <div class="score-breakdown">
        ${orbitalBar('semi_major_axis', phys.orbital.semi_major_axis, 7,         'AU', 2)}
        ${orbitalBar('eccentricity',    phys.orbital.eccentricity,    1,         '',   3)}
        ${orbitalBar('inclination',     phys.orbital.inclination,     Math.PI/2, 'rad', 3)}
        ${orbitalBar('orbital_period',  phys.orbital.orbital_period,  18,        'yr', 2)}
        ${orbitalBar('perihelion',      phys.orbital.perihelion,      7,         'AU', 2)}
        ${orbitalBar('aphelion',        phys.orbital.aphelion,        14,        'AU', 2)}
        ${orbitalBar('mean_anomaly',    phys.orbital.mean_anomaly,    2*Math.PI, 'rad', 3)}
      </div>
    ` : ''}

    ${phys.optical ? `
      <h4 style="margin-top:18px">Optical properties</h4>
      <div class="score-breakdown">
        <span class="label">wavelength</span>
        <span class="bar"><span class="bar-fill phys" style="width:${((phys.optical.wavelength - 380) / (750 - 380) * 100).toFixed(0)}%"></span></span>
        <span class="val"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:middle;margin-right:4px;background:${nmToRGB(phys.optical.wavelength)};box-shadow:0 0 6px ${nmToRGB(phys.optical.wavelength)}"></span>${phys.optical.wavelength} nm</span>
        ${physBar('polarization',  phys.optical.polarization  ?? 0)}
        ${physBar('amplitude',     phys.optical.amplitude     ?? 0)}
        ${orbitalBar('phase',      phys.optical.phase ?? 0,   2*Math.PI, 'rad', 3)}
      </div>
    ` : ''}

    ${pills.length ? `<div class="classification-meta">${pills.join('')}</div>` : ''}
    ${decisionRule}
  `
}

function renderDynamicSkillBody(skill) {
  const kws = (skill.keywords || []).map(k => `<code>${escapeHTML(k)}</code>`).join(' ')
  const body = skill.body
    ? `<div class="skill-md">${renderMarkdown(skill.body)}</div>`
    : `<p>${escapeHTML(skill.description || '')}</p>`
  return (
    `<p class="skill-tagline">${escapeHTML(skill.description || '')}</p>` +
    body +
    (kws
      ? `<div class="skill-keywords"><span class="kw-label">Keywords</span>${kws}</div>`
      : '')
  )
}

// AR mode wiring ----------------------------------------------------------
// Safari is strict: getUserMedia must be called synchronously in the same
// task as the click — no awaits between. Otherwise the user-gesture token
// is lost and the permission prompt is silently denied. So we kick the
// stream request immediately, then pass the in-flight Promise to startAR.
let arActive = false

function isMediaSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
}

arBtn.addEventListener('click', () => {
  if (arActive) {
    stopAR()
    arSection.hidden = true
    arActive = false
    arBtn.classList.remove('active')
    document.getElementById('arRescanBtn')?.remove()
    return
  }

  if (!isMediaSupported()) {
    arSection.hidden = false
    $('arStatus').textContent =
      'Camera API not available — needs HTTPS + a modern browser. iOS in-app browsers (Instagram/X) often block this; open in Safari/Chrome directly.'
    return
  }

  // *** Safari: call getUserMedia HERE, synchronously, before any await ***
  let streamPromise
  try {
    streamPromise = navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (e) {
    arSection.hidden = false
    $('arStatus').textContent = 'AR failed (sync): ' + (e.message || e)
    return
  }

  arSection.hidden = false
  arActive = true
  arBtn.classList.add('active')
  arSection.scrollIntoView({ behavior: 'smooth', block: 'center' })

  startAR({
    stream:     streamPromise,
    videoEl:    $('arVideo'),
    overlayEl:  $('arOverlay'),
    statusEl:   $('arStatus'),
    detsEl:     $('arDetections'),
    onDetectedClass: (className) => {
      // ar-mode self-locks on emit. We won't get another callback until
      // unlockAR() is called — either by the user clicking "scan again"
      // or by the routing call finishing in error.
      if (routingInFlight) return  // belt-and-suspenders
      $('arStatus').textContent = `🎯 detected: ${className} — generating skills…`
      taskInput.value = `What skills would help me interact with a ${className}?`
      askBtn.click()
    },
  }).catch(e => {
    $('arStatus').textContent = 'AR failed: ' + (e.message || e)
    arActive = false
    arBtn.classList.remove('active')
  })
})
$('arCloseBtn').addEventListener('click', () => { arBtn.click() })

// "Scan another object" — visible only when AR is running AND it's
// currently locked (i.e. has fired one route call and is waiting).
function showRescanButton() {
  if (!arActive) return
  let btn = $('arRescanBtn')
  if (!btn) {
    btn = document.createElement('button')
    btn.id = 'arRescanBtn'
    btn.className = 'btn-ghost ar-rescan-btn'
    btn.textContent = '🔄 scan another object'
    btn.addEventListener('click', () => {
      unlockAR()
      btn.remove()
      $('arStatus').textContent = 'scanning…'
    })
    arSection.appendChild(btn)
  }
}

// MARKDOWN ---------------------------------------------------------------
function renderMarkdown(md) {
  const codeBlocks = []
  md = md.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code class="lang-${escapeHTML(lang)}">${escapeHTML(code)}</code></pre>`)
    return ` CODE${codeBlocks.length - 1} `
  })

  const inlines = []
  md = md.replace(/`([^`\n]+)`/g, (_, c) => {
    inlines.push(`<code>${escapeHTML(c)}</code>`)
    return ` INL${inlines.length - 1} `
  })

  md = escapeHTML(md)

  md = md.replace(/^(#{1,6})\s+(.+)$/gm, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`)

  md = md.replace(/((?:^[-*]\s+.+(?:\n|$))+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('')
    return `<ul>${items}</ul>\n`
  })

  md = md
    .split(/\n{2,}/)
    .map(b => {
      const t = b.trim()
      if (!t) return ''
      if (/^<(h\d|ul|ol|pre)[\s>]/.test(t) || t.startsWith(' CODE')) return t
      return `<p>${t.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')

  md = md.replace(/ INL(\d+) /g,  (_, i) => inlines[+i])
  md = md.replace(/ CODE(\d+) /g, (_, i) => codeBlocks[+i])
  return md
}
