// arXiv fetcher — pulls the abstract page, extracts metadata, and
// normalizes the id / url forms we accept.

export interface ArxivMeta {
  arxiv_id: string          // 2606.XXXXX
  arxiv_idv: string         // 2606.XXXXXvN
  title: string
  authors: string[]
  abstract: string          // cleaned
  primary_subject: string   // "Quantum Physics (quant-ph)"
  comments: string          // "14+12 pages, 11 figures" or ""
  doi: string               // "10.48550/arXiv.2606.XXXXX" or ""
  abs_url: string
  pdf_url: string
}

const ID_RE = /arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})(v\d+)?/i

export function normalizeArxivUrl(input: string): { id: string; abs_url: string; pdf_url: string } {
  const trimmed = input.trim()
  // Bare id "2606.12345"
  const bare = trimmed.match(/^([0-9]{4}\.[0-9]{4,5})(v\d+)?$/i)
  if (bare) {
    const id = bare[1]
    return {
      id,
      abs_url: `https://arxiv.org/abs/${id}`,
      pdf_url: `https://arxiv.org/pdf/${id}`,
    }
  }
  // arXiv URL
  const m = trimmed.match(ID_RE)
  if (m) {
    const id = m[1]
    return {
      id,
      abs_url: `https://arxiv.org/abs/${id}`,
      pdf_url: `https://arxiv.org/pdf/${id}${m[2] ?? ""}`,
    }
  }
  throw new Error(`not an arXiv id or url: ${input}`)
}

function extract(html: string, re: RegExp): string | null {
  const m = html.match(re)
  return m ? m[1].trim() : null
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

export async function fetchArxiv(abs_url: string): Promise<ArxivMeta> {
  const res = await fetch(abs_url, {
    headers: { "user-agent": "meridian-studio/0.1 (+https://ask-meridian.uk)" },
  })
  if (!res.ok) throw new Error(`arxiv fetch failed: ${res.status}`)
  const html = await res.text()

  const idv = extract(html, /<meta name="citation_arxiv_id"[^>]*content="([^"]+)"/)
              ?? extract(html, /arxiv\.org\/abs\/([0-9]{4}\.[0-9]{4,5}v\d+)/)
              ?? ""
  const idBare = idv.replace(/v\d+$/, "")
  const title  = extract(html, /<meta name="citation_title"[^>]*content="([^"]+)"/) ?? "Untitled"
  const authors = [...html.matchAll(/<meta name="citation_author"[^>]*content="([^"]+)"/g)].map(m => m[1])
  const absMatch = html.match(/<blockquote class="abstract[^"]*">([\s\S]+?)<\/blockquote>/)
  const abstract = absMatch ? stripTags(absMatch[1].replace(/^Abstract:\s*/i, "")) : ""
  const subject = extract(html, /<span class="primary-subject">([^<]+)<\/span>/) ?? ""
  const commentsMatch = html.match(/<td class="tablecell comments[^"]*">([\s\S]+?)<\/td>/)
  const comments = commentsMatch ? stripTags(commentsMatch[1]) : ""
  const doi = extract(html, /doi\.org\/(arXiv\.[0-9.]+)/) ?? `arXiv.${idBare}`

  if (!title || !abstract) {
    throw new Error(`could not parse arxiv page (title=${!!title} abstract=${!!abstract})`)
  }

  return {
    arxiv_id: idBare,
    arxiv_idv: idv || idBare,
    title,
    authors,
    abstract,
    primary_subject: subject,
    comments,
    doi,
    abs_url: `https://arxiv.org/abs/${idBare}`,
    pdf_url: `https://arxiv.org/pdf/${idBare}`,
  }
}

// Slugify a title into a lowercase-with-hyphens URL component.
// Strips the arXiv id if the title starts with one (common in auto-fetched titles).
export function slugifyTitle(title: string, arxivId: string): string {
  let s = title.trim()
  // Drop a leading arXiv id if present (the page sometimes returns "2606.12345 Title...")
  s = s.replace(new RegExp(`^${arxivId}\\s*[vV]?\\d*\\s*[:\\-]?\\s*`), "")
  s = s.toLowerCase()
  s = s.replace(/[^a-z0-9]+/g, "-")
  s = s.replace(/^-+|-+$/g, "")
  // Cap at 80 chars without breaking on a hyphen separator
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, "")
  if (!s) s = arxivId
  return s
}
