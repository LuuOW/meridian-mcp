// /miniapp interactive demo
// Calls /api/orbital-route — fully dynamic: LLM generates skills,
// open-domain orbital classifier assigns celestial classes.
import { MiniGalaxy } from './mini-galaxy.js'
import { startAR, stopAR, unlockAR, isLocked } from './ar-mode.js'
import { renderPhysicsPanel } from './physics-panel.js'
import { routeTaskStream } from './api.js'
import { escapeHTML, renderMarkdown } from './_md.js'
import { initBurgerNav, loadVersionBadge } from '/nav.js'

initBurgerNav()
loadVersionBadge('versionBadge')

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
    '<p class="routing-progress" id="streamProgress">connecting to orbital router…</p>' +
    '</li>'
  resultsMeta.textContent = ''
  latestSelected = []
  closePanel()

  const provider = modelSelect?.value || 'workers-ai'
  try {
    const summary = await routeTaskStream(
      { task, limit: ROUTE_LIMIT, provider },
      {
        onProgress: (p) => {
          const el = document.getElementById('streamProgress')
          if (!el) return
          if (p.stage === 'connected')           el.textContent = 'connected · waiting for LLM…'
          else if (p.stage === 'cache_hit')      el.textContent = `cache hit (${p.cache_age_s}s old) — replaying`
          else if (p.stage === 'cache_miss')     el.textContent = 'cache miss · authoring fresh skills…'
          else if (p.stage === 'llm_streaming_start') el.textContent = `LLM warming up (${p.model})…`
          else if (p.stage === 'llm_streaming')  el.textContent = `LLM writing… ${p.chars.toLocaleString()} chars · ${(p.ms / 1000).toFixed(1)}s`
          else if (p.stage === 'llm_calling')    el.textContent = `LLM running (${p.model})…`
          else if (p.stage === 'llm_complete')   el.textContent = `LLM done in ${(p.ms / 1000).toFixed(1)}s · classifying…`
          else if (p.stage === 'rag_retrieved')  el.textContent = `RAG: ${p.matches} similar past skills (top score ${p.top_score})`
          else if (p.stage === 'classifying')    el.textContent = `classifying ${p.candidates_generated} candidates orbitally…`
          else if (p.stage === 'semantic_rerank') el.textContent = `semantic re-rank (${p.model})…`
        },
        onSkill: (s) => {
          // First skill arrival clears the placeholder.
          if (!latestSelected.length) resultsList.innerHTML = ''
          latestSelected.push(s)
          appendSkillCard(s)
          galaxy.setSkills(latestSelected)
        },
      },
    )
    refreshQuota()
    renderMeta(summary)
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

function appendSkillCard(s) {
  const cls = s.classification?.class || ''
  const sys = s.classification?.star_system || ''
  const li = document.createElement('li')
  li.className = 'result-item result-item-in'
  li.dataset.slug = s.slug
  li.innerHTML = `
    <div class="result-head">
      <span class="result-slug">${escapeHTML(s.slug)}</span>
      ${cls ? `<span class="result-class" data-class="${escapeHTML(cls)}">${escapeHTML(cls)}</span>` : ''}
      ${sys ? `<span class="result-system">${escapeHTML(sys)}</span>` : ''}
      <span class="result-score">${s.route_score.toFixed(1)}</span>
    </div>
    <p class="result-desc">${escapeHTML(s.description || '')}</p>
    <div class="result-why">${escapeHTML(s.why || '')}</div>`
  li.addEventListener('click', () => openPanel(s.slug))
  resultsList.appendChild(li)
}

function renderMeta(summary) {
  if (!summary) return
  if (!latestSelected.length) {
    resultsList.innerHTML = '<li class="no-results">No skills matched. Try different wording or one of the examples.</li>'
    return
  }
  let meta = `<span class="conf-${summary.confidence}">${summary.confidence}</span> · ` +
             `top <strong>${summary.top_score.toFixed(1)}</strong> · ` +
             `${latestSelected.length}/${summary.candidates_generated || latestSelected.length} skills`
  if (summary.timing) {
    meta += ` · LLM ${summary.timing.llm_ms} ms + classify ${summary.timing.classify_ms} ms`
    if (summary.timing.embed_ms) meta += ` + embed ${summary.timing.embed_ms} ms`
  }
  if (summary.cache_hit) meta += ' · ⚡ cache'
  resultsMeta.innerHTML = meta
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
    ${renderPhysicsPanel(skill)}
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

