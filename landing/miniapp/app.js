// /miniapp interactive demo
// Calls /api/route on Pages Functions; renders ranked skills.
import { MiniGalaxy } from './mini-galaxy.js'

const $ = id => document.getElementById(id)
const taskInput      = $('taskInput')
const limitSelect    = $('limitSelect')
const askBtn         = $('askBtn')
const charCount      = $('charCount')
const resultsSection = $('resultsSection')
const resultsList    = $('resultsList')
const resultsMeta    = $('resultsMeta')
const skillDetail    = $('skillDetail')
const skillTitle     = $('skillTitle')
const skillBody      = $('skillBody')
const closeSkill     = $('closeSkill')
const miniGalaxyCanvas = $('miniGalaxyCanvas')
const mode2dBtn        = $('mode2d')
const mode3dBtn        = $('mode3d')

const galaxy = new MiniGalaxy(miniGalaxyCanvas, {
  mode: '2d',
  onPlanetClick: slug => {
    const item = resultsList.querySelector(`[data-slug="${CSS.escape(slug)}"]`)
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' })
      item.style.boxShadow = '0 0 0 2px var(--neon-violet, #a78bfa), 0 0 24px rgba(167,139,250,0.45)'
      setTimeout(() => { item.style.boxShadow = '' }, 1200)
    }
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
  askBtn.textContent = 'Routing…'
  resultsSection.hidden = false
  resultsList.innerHTML = '<li class="no-results">Scoring 88 skills…</li>'
  resultsMeta.textContent = ''
  skillDetail.hidden = true

  try {
    const res = await fetch('/api/route', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ task, limit: parseInt(limitSelect.value, 10) || 5 }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    renderResults(data)
  } catch (err) {
    resultsList.innerHTML = `<li class="no-results">Error: ${escapeHTML(err.message)}</li>`
  } finally {
    askBtn.disabled = false
    askBtn.textContent = 'Route this task →'
  }
})

function renderResults(data) {
  galaxy.setSkills(data.selected || [])

  resultsMeta.innerHTML =
    `<span class="conf-${data.confidence}">${data.confidence}</span> · ` +
    `top score <strong>${data.top_score.toFixed(1)}</strong> · ` +
    `${data.selected.length} result${data.selected.length === 1 ? '' : 's'}`

  if (!data.selected.length) {
    resultsList.innerHTML = '<li class="no-results">No skills matched. Try different wording or one of the examples.</li>'
    return
  }

  resultsList.innerHTML = data.selected.map(s => `
    <li class="result-item" data-slug="${escapeHTML(s.slug)}">
      <div class="result-head">
        <span class="result-slug">${escapeHTML(s.slug)}</span>
        <span class="result-score">${s.route_score.toFixed(1)}</span>
      </div>
      <p class="result-desc">${escapeHTML(s.description || '')}</p>
      <div class="result-why">${escapeHTML(s.why || '')}</div>
    </li>
  `).join('')

  resultsList.querySelectorAll('.result-item').forEach(el => {
    el.addEventListener('click', () => loadSkill(el.dataset.slug))
  })
}

async function loadSkill(slug) {
  skillDetail.hidden = false
  skillTitle.textContent = slug
  skillBody.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>'
  skillDetail.scrollIntoView({ behavior: 'smooth', block: 'start' })

  try {
    const res  = await fetch(`/api/skill/${encodeURIComponent(slug)}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    skillBody.innerHTML = renderMarkdown(data.body || '')
  } catch (err) {
    skillBody.innerHTML = `<p style="color:#f87171">Failed to load: ${escapeHTML(err.message)}</p>`
  }
}

closeSkill.addEventListener('click', () => { skillDetail.hidden = true })

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
