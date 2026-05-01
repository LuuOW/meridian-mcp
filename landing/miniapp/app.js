// /miniapp interactive demo
// Calls /api/route (or /api/dynamic-route when "🪐 dynamic" is on).
import { MiniGalaxy } from './mini-galaxy.js'
import { startAR, stopAR } from './ar-mode.js'

const $ = id => document.getElementById(id)
const taskInput      = $('taskInput')
const limitSelect    = $('limitSelect')
const askBtn         = $('askBtn')
const charCount      = $('charCount')
const dynamicToggle  = $('dynamicToggle')
const arBtn          = $('arBtn')
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

function updateCharCount() {
  const n = taskInput.value.length
  charCount.textContent = `${n} / 800`
  charCount.classList.toggle('warn', n > 700)
}

taskInput.addEventListener('input', updateCharCount)
updateCharCount()

document.querySelectorAll('.ex-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    taskInput.value = chip.dataset.task
    updateCharCount()
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
  const task = taskInput.value.trim()
  if (!task) {
    taskInput.focus()
    return
  }

  askBtn.disabled = true
  askBtn.textContent = dynamicToggle.checked ? 'Generating + scoring…' : 'Routing…'
  resultsSection.hidden = false
  requestAnimationFrame(() => galaxy._resize())
  resultsList.innerHTML = '<li class="no-results">Scoring corpus…</li>'
  resultsMeta.textContent = ''
  closePanel()

  try {
    const data = await routeTask(task, parseInt(limitSelect.value, 10) || 5)
    renderResults(data)
  } catch (err) {
    resultsList.innerHTML = `<li class="no-results">Error: ${escapeHTML(err.message)}</li>`
  } finally {
    askBtn.disabled = false
    askBtn.textContent = 'Find compatible skills →'
  }
})

async function routeTask(task, limit) {
  const useDynamic = dynamicToggle.checked
  const url  = useDynamic ? '/api/dynamic-route' : '/api/route'
  const body = useDynamic
    ? { task, limit, mode: 'hybrid' }
    : { task, limit }
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function renderResults(data) {
  latestSelected = data.selected || []
  galaxy.setSkills(latestSelected)

  let meta = `<span class="conf-${data.confidence}">${data.confidence}</span> · ` +
             `top score <strong>${data.top_score.toFixed(1)}</strong> · ` +
             `${latestSelected.length} result${latestSelected.length === 1 ? '' : 's'}`
  if (typeof data.dynamic_count === 'number') {
    meta += ` · <span class="meta-dyn">${data.dynamic_count} dynamic</span> + ${data.static_count} static`
    if (data.ai_latency_ms) meta += ` · LLM ${data.ai_latency_ms} ms`
    if (data.dynamic_error) meta += ` · <span style="color:#f87171" title="${escapeHTML(data.dynamic_error)}">⚠ LLM fallback</span>`
  }
  resultsMeta.innerHTML = meta

  if (!latestSelected.length) {
    resultsList.innerHTML = '<li class="no-results">No skills matched. Try different wording or one of the examples.</li>'
    return
  }

  resultsList.innerHTML = latestSelected.map(s => {
    const cls = s.classification?.class || (s.source === 'dynamic' ? 'dynamic' : '')
    return `
    <li class="result-item ${s.source === 'dynamic' ? 'is-dynamic' : ''}" data-slug="${escapeHTML(s.slug)}" data-source="${escapeHTML(s.source || 'static')}">
      <div class="result-head">
        <span class="result-slug">${escapeHTML(s.slug)}</span>
        ${cls ? `<span class="result-class" data-class="${escapeHTML(cls)}">${escapeHTML(cls)}</span>` : ''}
        ${s.source === 'dynamic' ? '<span class="result-tag">🪐 LLM</span>' : ''}
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

  const cls = skill.classification?.class || (skill.source === 'dynamic' ? 'dynamic' : '')
  panelClass.textContent = cls || ''
  panelClass.dataset.class = cls
  panelClass.style.display = cls ? 'inline-flex' : 'none'

  panelWhy.innerHTML  = renderWhy(skill)
  panelContent.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Loading skill…</p>'

  panel.hidden = false
  // tick to allow display change to apply before transition
  requestAnimationFrame(() => panel.setAttribute('aria-hidden', 'false'))
  document.body.style.overflow = 'hidden'

  // Load the description / body
  if (skill.source === 'dynamic') {
    panelContent.innerHTML = renderDynamicSkillBody(skill)
  } else {
    fetch(`/api/skill/${encodeURIComponent(skill.slug)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => { panelContent.innerHTML = renderMarkdown(data.body || skill.description || '') })
      .catch(e => { panelContent.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHTML(e.message)}</p>` })
  }
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

  // Score breakdown bars normalised against the largest contributing component
  const kw   = b.kw_idf   || 0
  const desc = b.desc_idf || 0
  const body = b.body_idf || 0
  const max  = Math.max(kw, desc, body, 1)

  const bar = (label, val) => `
    <span class="label">${escapeHTML(label)}</span>
    <span class="bar"><span class="bar-fill" style="width:${(val / max * 100).toFixed(0)}%"></span></span>
    <span class="val">${val.toFixed(1)}</span>`

  const tokens = (b.tokens || []).map(t => `<span class="tok">${escapeHTML(t)}</span>`).join('')

  const pills = []
  if (cls.parent)              pills.push(`<span class="meta-pill">parent <em>${escapeHTML(cls.parent)}</em></span>`)
  if (cls.star_system)         pills.push(`<span class="meta-pill">system <em>${escapeHTML(cls.star_system)}</em></span>`)
  if (cls.lagrange_systems?.length > 1)
    pills.push(`<span class="meta-pill">bridges <em>${cls.lagrange_systems.map(escapeHTML).join(' ↔ ')}</em></span>`)
  if (cls.lagrange_potential)
    pills.push(`<span class="meta-pill">L-potential <em>${cls.lagrange_potential.toFixed(2)}</em></span>`)
  if (cls.tidal_lock)          pills.push(`<span class="meta-pill" title="Always co-loads with parent">tidal-locked</span>`)
  if (cls.habitable_zone)      pills.push(`<span class="meta-pill" title="Stable activation profile">habitable-zone</span>`)
  if (b.class && b.class_mult > 1) pills.push(`<span class="meta-pill">class boost <em>×${b.class_mult.toFixed(2)}</em></span>`)
  if (b.lagrange_mult > 1.01)  pills.push(`<span class="meta-pill">versatility <em>×${b.lagrange_mult.toFixed(2)}</em></span>`)
  if (b.diversity_mult > 1.01) pills.push(`<span class="meta-pill">diversity <em>×${b.diversity_mult.toFixed(2)}</em></span>`)

  const decisionRule = cls.decision_rule
    ? `<div class="decision-rule"><strong>Why this class:</strong> ${escapeHTML(cls.decision_rule)}</div>`
    : (skill.source === 'dynamic'
        ? `<div class="decision-rule"><strong>Generated:</strong> Llama-3.1-8b proposed this skill given the task. The lexical scorer ranked it on equal footing with the static corpus.</div>`
        : '')

  return `
    <h4>Why score = ${skill.route_score.toFixed(2)}</h4>
    <div class="score-breakdown">
      ${bar('keywords (×10)',   kw)}
      ${bar('description (×5)', desc)}
      ${bar('body (×0.3)',      body)}
    </div>
    ${tokens ? `<div class="token-hits">${tokens}</div>` : ''}
    ${pills.length ? `<div class="classification-meta">${pills.join('')}</div>` : ''}
    ${decisionRule}
  `
}

function renderDynamicSkillBody(skill) {
  return (
    `<p style="color:#a78bfa;font-family:var(--font-mono);font-size:11.5px;margin-bottom:14px">` +
    `🪐 Generated by Llama-3.1-8b — no SKILL.md exists for this candidate.</p>` +
    `<p>${escapeHTML(skill.description || '')}</p>` +
    (skill.classification?.scores ? '' : '') +
    `<p style="color:var(--text-muted);font-size:13px;margin-top:14px">` +
    `In a real deployment, an authoring step would convert promising LLM candidates into committed SKILL.md files.</p>`
  )
}

// AR mode wiring ----------------------------------------------------------
let arActive = false
arBtn.addEventListener('click', async () => {
  if (arActive) {
    stopAR()
    arSection.hidden = true
    arActive = false
    arBtn.classList.remove('active')
    return
  }
  arSection.hidden = false
  arActive = true
  arBtn.classList.add('active')
  arSection.scrollIntoView({ behavior: 'smooth', block: 'center' })
  try {
    await startAR({
      videoEl:    $('arVideo'),
      overlayEl:  $('arOverlay'),
      statusEl:   $('arStatus'),
      detsEl:     $('arDetections'),
      onDetectedClass: (className) => {
        taskInput.value = `What skills would help me interact with a ${className}?`
        updateCharCount()
        askBtn.click()
      },
    })
  } catch (e) {
    $('arStatus').textContent = 'AR failed: ' + (e.message || e)
  }
})
$('arCloseBtn').addEventListener('click', () => { arBtn.click() })

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
