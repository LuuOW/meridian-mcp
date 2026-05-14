#!/usr/bin/env python3
"""Single-source nav sync across every browser-facing HTML in the monorepo.

Edit to change the nav anywhere:
  landing/_nav-data.json   — apps / resources / source items
  landing/_nav.html        — template with {{SHOWCASE}} {{RESOURCES}} {{SOURCE}} {{CMDK_INDEX}}

The new horizontal top-bar + Apps dropdown + ⌘K palette ship from this
template; the script also generates the JSON index baked into every
page so ⌘K works offline (no fetch).

For pages under landing/docs/ this script injects a sticky table-of-
contents sidebar based on the page's own <h2> / <h3> headings.

Surfaces walked:
  - landing/                       → GH Pages on ask-meridian.uk
  - helix/, miniapp/               → CF Pages on meridian.ask-meridian.uk/*
  - lens/                          → CF Pages on meridian.ask-meridian.uk/lens
  - photon-route/pages/            → standalone GH Pages on photon.ask-meridian.uk

Usage:
    python3 scripts/sync-nav.py
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
LANDING   = ROOT / 'landing'
DATA_PATH = LANDING / '_nav-data.json'
TEMPLATE  = LANDING / '_nav.html'

SURFACES  = [
    ROOT / 'landing',
    ROOT / 'helix',
    ROOT / 'lens',
    ROOT / 'miniapp',
    ROOT / 'photon-route' / 'pages',
]

NAV_RE = re.compile(r'<nav class="nav".*?</nav>', re.DOTALL)
H2_RE  = re.compile(r'<h2\s+id="([^"]+)"[^>]*>(.*?)</h2>', re.DOTALL)
H3_RE  = re.compile(r'<h3\s+id="([^"]+)"[^>]*>(.*?)</h3>', re.DOTALL)
TOC_PLACEHOLDER = re.compile(r'<aside class="docs-toc"[^>]*>.*?</aside>', re.DOTALL)
BLOG_TITLE_RE = re.compile(r'<h1[^>]*>(.*?)</h1>', re.DOTALL)
EMOJI_PREFIX_RE = re.compile(r'^[^\w<]+', re.UNICODE)
TAG_STRIP_RE   = re.compile(r'<[^>]+>')
NAV_CSS_LINK_RE = re.compile(r'<link[^>]*data-nav-css[^>]*>')
# Body-level <style> blocks that ONLY redefine nav classes — leftover from
# before nav.css existed. We strip them so the head-level nav.css wins the
# cascade. Conservative match: must contain ".nav {" or ".nav-menu {"
# AND nothing outside nav scope.
LEGACY_NAV_STYLE_RE = re.compile(
    r'<style>\s*\.nav\s*\{.*?</style>',
    re.DOTALL,
)
NAV_CSS_VERSION = '2026-05-14'


def render_showcase(items):
    out = []
    for it in items:
        out.append(
            f'      <a href="{it["href"]}" class="nav-app" data-status="live">\n'
            f'        <span class="nav-app-name"><span class="nav-app-emoji">{it["emoji"]}</span>{it["name"]}</span>\n'
            f'        <span class="nav-app-tag">{it["tag"]}</span>\n'
            f'      </a>'
        )
    return '\n'.join(out).lstrip()


def render_links(items):
    return '\n'.join(f'      <a href="{it["href"]}">{it["label"]}</a>' for it in items).lstrip()


def strip_tags(s: str) -> str:
    return TAG_STRIP_RE.sub('', s).strip()


def collect_blog_posts() -> list[dict]:
    """Walk landing/blog/*/index.html, pull <h1> as title, build hrefs."""
    out = []
    blog_dir = LANDING / 'blog'
    if not blog_dir.exists():
        return out
    for path in sorted(blog_dir.rglob('index.html')):
        if path.parent == blog_dir:
            continue  # /blog/ index itself
        text = path.read_text(encoding='utf-8')
        m = BLOG_TITLE_RE.search(text)
        if not m:
            continue
        title = strip_tags(m.group(1))
        if not title:
            continue
        slug = path.parent.name
        out.append({
            'label': title,
            'href': f'https://ask-meridian.uk/blog/{slug}/',
            'category': 'Blog',
            'emoji': '✎',
        })
    return out


def build_cmdk_index(data: dict) -> list[dict]:
    """Flatten apps + resources + source + blog into a single search list.
    Each entry: { label, href, category, emoji }."""
    out = []
    for it in data.get('showcase', []):
        out.append({
            'label': it['name'],
            'tag':   it.get('tag', ''),
            'href':  it['href'],
            'category': 'App',
            'emoji': it.get('emoji', '·'),
        })
    out.append({'label': 'Home', 'href': 'https://ask-meridian.uk/', 'category': 'Page', 'emoji': '◎'})
    for it in data.get('resources', []):
        out.append({
            'label': it['label'],
            'href':  it['href'],
            'category': 'Page',
            'emoji': '·',
        })
    for it in data.get('source', []):
        out.append({
            'label': it['label'],
            'href':  it['href'],
            'category': 'Source',
            'emoji': '⌥',
        })
    out.extend(collect_blog_posts())
    return out


def render_template(data: dict, cmdk_index: list[dict]) -> str:
    raw = TEMPLATE.read_text(encoding='utf-8')
    raw = raw.replace('{{SHOWCASE}}',  render_showcase(data['showcase']))
    raw = raw.replace('{{RESOURCES}}', render_links(data['resources']))
    raw = raw.replace('{{SOURCE}}',    render_links(data['source']))
    # Escape `</` so a stray "</script>" in a blog title can't end the inline tag.
    cmdk_json = json.dumps(cmdk_index, ensure_ascii=False).replace('</', '<\\/')
    raw = raw.replace('{{CMDK_INDEX}}', cmdk_json)
    return raw.strip()


def build_toc(html: str) -> str:
    """For docs page: find h2 (and following h3s) and produce a nested TOC.
    Returns the inner HTML of <aside class="docs-toc">."""
    # Split body on h2 to get sections; for each h2, find h3s before the next h2.
    sections = []  # list of (h2_id, h2_text, [(h3_id, h3_text), ...])
    pos = 0
    h2_matches = list(H2_RE.finditer(html))
    if not h2_matches:
        return ''
    for i, m in enumerate(h2_matches):
        h2_id = m.group(1)
        h2_text = strip_tags(m.group(2))
        end = h2_matches[i + 1].start() if i + 1 < len(h2_matches) else len(html)
        sub = html[m.end():end]
        h3s = [(hm.group(1), strip_tags(hm.group(2))) for hm in H3_RE.finditer(sub)]
        sections.append((h2_id, h2_text, h3s))
    lines = ['<div class="docs-toc-title">On this page</div>', '<ul>']
    for h2_id, h2_text, h3s in sections:
        lines.append(f'  <li><a href="#{h2_id}">{h2_text}</a>')
        if h3s:
            lines.append('    <ul>')
            for h3_id, h3_text in h3s:
                lines.append(f'      <li><a href="#{h3_id}">{h3_text}</a></li>')
            lines.append('    </ul>')
        lines.append('  </li>')
    lines.append('</ul>')
    return '\n'.join(lines)


def inject_nav_css(path: Path, html: str) -> tuple[str, bool]:
    """Ensure <link rel="stylesheet" href="…/nav.css" data-nav-css> sits
    right before </head>, so its rules cascade-win against any older inline
    or per-page nav rules. Idempotent via the data-nav-css marker.

    Cross-origin pages (helix/lens/miniapp on meridian.ask-meridian.uk;
    photon-route on photon.ask-meridian.uk) load from the absolute URL on
    ask-meridian.uk. Same-origin landing pages use the root-relative path.
    """
    same_origin = path.is_relative_to(LANDING)
    href = ('/nav.css' if same_origin else 'https://ask-meridian.uk/nav.css') + f'?v={NAV_CSS_VERSION}'
    link_tag = f'<link rel="stylesheet" href="{href}" data-nav-css>'
    if NAV_CSS_LINK_RE.search(html):
        new = NAV_CSS_LINK_RE.sub(link_tag, html, count=1)
        return new, new != html
    closing = re.search(r'</head>', html, re.IGNORECASE)
    if not closing:
        return html, False
    new = html[:closing.start()] + link_tag + '\n' + html[closing.start():]
    return new, True


def strip_legacy_nav_style(html: str) -> tuple[str, bool]:
    """Remove standalone body-level <style> blocks that exist only to define
    the old self-contained nav. The head-level nav.css now owns those rules.
    Also strips the preceding documentation comment block if present, so we
    don't leave orphan banners around."""
    new = LEGACY_NAV_STYLE_RE.sub('', html)
    # Clean up the standalone "Shared meridian nav · self-contained" banner
    # comment that introduced the stripped block.
    new = re.sub(
        r'<!--\s*=+\s*\n?\s*Shared meridian nav · self-contained.*?-+\s*-->\s*',
        '',
        new,
        flags=re.DOTALL,
    )
    return new, new != html


def inject_toc(path: Path, html: str) -> tuple[str, bool]:
    """If this is a docs page, ensure a <aside class="docs-toc"> sits next
    to the main content. Replaces an existing TOC if present, otherwise
    inserts before <main>/<article>. Returns (new_html, changed?)."""
    if 'docs' not in path.parts:
        return html, False
    toc_html = build_toc(html)
    if not toc_html:
        return html, False
    aside = f'<aside class="docs-toc" aria-label="Table of contents">\n{toc_html}\n</aside>'
    if TOC_PLACEHOLDER.search(html):
        new = TOC_PLACEHOLDER.sub(aside, html, count=1)
        return new, new != html
    # Otherwise inject before <main> or <article> — and wrap that element in a docs-with-toc grid.
    target_re = re.compile(r'(<(main|article)\b[^>]*>)', re.IGNORECASE)
    m = target_re.search(html)
    if not m:
        return html, False
    wrapped = f'<div class="docs-with-toc">\n{aside}\n{m.group(0)}'
    new = html[:m.start()] + wrapped + html[m.end():]
    # Close the wrapper: find the matching </main> or </article> at end and append </div>.
    close_tag = f'</{m.group(2)}>'
    last = new.rfind(close_tag)
    if last == -1:
        return html, False
    new = new[:last + len(close_tag)] + '\n</div>' + new[last + len(close_tag):]
    return new, True


def main() -> int:
    if not DATA_PATH.exists():
        print(f'missing {DATA_PATH.relative_to(ROOT)}', file=sys.stderr)
        return 1
    if not TEMPLATE.exists():
        print(f'missing {TEMPLATE.relative_to(ROOT)}', file=sys.stderr)
        return 1
    data = json.loads(DATA_PATH.read_text())
    for k in ('showcase', 'resources', 'source'):
        if k not in data:
            print(f'_nav-data.json missing key: {k}', file=sys.stderr)
            return 1

    cmdk_index = build_cmdk_index(data)
    rendered_nav = render_template(data, cmdk_index)
    updated_nav = updated_toc = updated_link = updated_strip = scanned = 0
    seen: set[Path] = set()
    for surface in SURFACES:
        if not surface.exists():
            continue
        for path in sorted(surface.rglob('*.html')):
            if path.name.startswith('_'):
                continue
            if path in seen:
                continue
            seen.add(path)
            scanned += 1
            original = path.read_text(encoding='utf-8')
            new_text = original
            if NAV_RE.search(new_text):
                replaced = NAV_RE.sub(lambda _m: rendered_nav, new_text, count=1)
                if replaced != new_text:
                    updated_nav += 1
                new_text = replaced
                stripped, did_strip = strip_legacy_nav_style(new_text)
                if did_strip:
                    new_text = stripped
                    updated_strip += 1
                linked, did_link = inject_nav_css(path, new_text)
                if did_link:
                    new_text = linked
                    updated_link += 1
            after_toc, toc_changed = inject_toc(path, new_text)
            if toc_changed:
                new_text = after_toc
                updated_toc += 1
            if new_text != original:
                path.write_text(new_text, encoding='utf-8')
                print(f'  updated {path.relative_to(ROOT)}')

    print(f'[sync-nav] nav: {updated_nav}/{scanned}; link+css: {updated_link}; legacy-style stripped: {updated_strip}; toc: {updated_toc}; cmdk-index: {len(cmdk_index)} entries')
    return 0


if __name__ == '__main__':
    sys.exit(main())
