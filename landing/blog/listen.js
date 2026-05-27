const MAX_CHARS = 1600

function toChunks(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned]
  const chunks = []
  let current = ''

  for (const sentence of sentences) {
    const next = sentence.trim()
    if (!next) continue

    const candidate = `${current} ${next}`.trim()
    if (candidate.length > MAX_CHARS && current) {
      chunks.push(current)
      current = next
    } else {
      current = candidate
    }
  }

  if (current) chunks.push(current)
  return chunks
}

function extractReadableText(article) {
  const clone = article.cloneNode(true)
  clone.querySelectorAll('script, style, pre, code, table, .listen-panel').forEach((node) => node.remove())

  return Array.from(clone.querySelectorAll('h1, h2, h3, p, li, blockquote'))
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join('. ')
}

function initListenControls() {
  const article = document.querySelector('.article-body, article.post')
  if (!article || article.querySelector('.listen-panel')) return

  const title = article.querySelector('h1')
  if (!title) return

  const panel = document.createElement('section')
  panel.className = 'listen-panel'
  panel.setAttribute('aria-label', 'Listen to this article')
  panel.innerHTML = `
    <div class="listen-copy">
      <div class="listen-title">Listen to this article</div>
      <div class="listen-status" aria-live="polite">Uses your browser's built-in text-to-speech.</div>
    </div>
    <div class="listen-controls">
      <button type="button" class="listen-btn listen-play">Play</button>
      <button type="button" class="listen-btn listen-stop" disabled>Stop</button>
      <label class="listen-rate">
        <span>Speed</span>
        <select aria-label="Playback speed">
          <option value="0.9">0.9x</option>
          <option value="1" selected>1x</option>
          <option value="1.15">1.15x</option>
          <option value="1.3">1.3x</option>
        </select>
      </label>
    </div>
  `
  title.insertAdjacentElement('afterend', panel)

  const play = panel.querySelector('.listen-play')
  const stop = panel.querySelector('.listen-stop')
  const status = panel.querySelector('.listen-status')
  const rate = panel.querySelector('select')

  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    play.disabled = true
    status.textContent = 'Text-to-speech is not available in this browser.'
    return
  }

  const synth = window.speechSynthesis
  const chunks = toChunks(extractReadableText(article))
  let index = 0
  let active = false
  let paused = false

  function setIdle(message = 'Ready when you are.') {
    active = false
    paused = false
    index = 0
    play.textContent = 'Play'
    stop.disabled = true
    status.textContent = message
  }

  function speakNext() {
    if (!active || index >= chunks.length) {
      setIdle('Finished.')
      return
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index])
    utterance.rate = Number(rate.value) || 1
    utterance.onstart = () => {
      status.textContent = `Playing section ${index + 1} of ${chunks.length}.`
    }
    utterance.onend = () => {
      index += 1
      speakNext()
    }
    utterance.onerror = () => {
      setIdle('Playback stopped by the browser.')
    }

    synth.speak(utterance)
  }

  play.addEventListener('click', () => {
    if (!chunks.length) {
      status.textContent = 'No readable article text found.'
      return
    }

    if (active && !paused) {
      synth.pause()
      paused = true
      play.textContent = 'Resume'
      status.textContent = 'Paused.'
      return
    }

    if (active && paused) {
      synth.resume()
      paused = false
      play.textContent = 'Pause'
      status.textContent = `Playing section ${Math.min(index + 1, chunks.length)} of ${chunks.length}.`
      return
    }

    synth.cancel()
    active = true
    paused = false
    index = 0
    play.textContent = 'Pause'
    stop.disabled = false
    speakNext()
  })

  stop.addEventListener('click', () => {
    synth.cancel()
    setIdle('Stopped.')
  })

  window.addEventListener('beforeunload', () => synth.cancel())
  setIdle()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initListenControls, { once: true })
} else {
  initListenControls()
}
