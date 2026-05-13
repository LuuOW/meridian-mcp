// Tiny browser-side Markdown renderer used by the miniapp and vision lab.
// Handles fenced code blocks, inline code, headings (h1–h6), bullet lists,
// and paragraphs — designed for the LLM-generated SKILL.md bodies the
// orbital router returns. Not a full CommonMark implementation: tables,
// blockquotes, links, emphasis, and ordered lists are intentionally
// out of scope so that one regression-prone shared module can serve both
// surfaces. Add features only if both surfaces actually need them.

export const escapeHTML = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
)

export function renderMarkdown(md) {
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
