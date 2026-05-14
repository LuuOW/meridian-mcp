#!/usr/bin/env python3
"""Sync nav blocks across every browser-facing HTML in the monorepo.

Source of truth (edit these to change the nav):

  landing/_nav-data.json   — showcase / resources / source items (CONTENT)
  landing/_nav.html        — .nav  template w/ {{SHOWCASE}} {{RESOURCES}} {{SOURCE}}
  landing/_m-nav.html      — .m-nav template w/ the same placeholders

Surfaces walked:
  - landing/                       → GH Pages on ask-meridian.uk
  - helix/, miniapp/               → CF Pages on meridian.ask-meridian.uk/*
  - lens/                          → CF Pages on meridian.ask-meridian.uk/lens
  - photon-route/pages/            → HF Space on photon.ask-meridian.uk
                                     (also push to standalone repo after)

Usage:
    python3 scripts/sync-nav.py

The script renders each template with the JSON data, then file-walks
every surface and patches the appropriate <nav>…</nav> block.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
LANDING   = ROOT / 'landing'
DATA_PATH = LANDING / '_nav-data.json'

SURFACES  = [
    ROOT / 'landing',
    ROOT / 'helix',
    ROOT / 'lens',
    ROOT / 'miniapp',
    ROOT / 'photon-route' / 'pages',
]

NAV_TEMPLATE_PATHS = {
    'nav':   LANDING / '_nav.html',
    'm-nav': LANDING / '_m-nav.html',
}
NAV_PATTERNS = {
    'nav':   re.compile(r'<nav class="nav".*?</nav>',   re.DOTALL),
    'm-nav': re.compile(r'<nav class="m-nav".*?</nav>', re.DOTALL),
}


# ── Per-namespace HTML emitters ───────────────────────────────────────
# The .nav and .m-nav surfaces use different class names + structures
# for each item type — keep one renderer per (namespace, item-type).

def render_nav_showcase(items):
    out = []
    for it in items:
        out.append(
            f'      <a href="{it["href"]}" class="nav-app" data-status="live">\n'
            f'        <span class="nav-app-name"><span class="nav-app-emoji">{it["emoji"]}</span>{it["name"]}</span>\n'
            f'        <span class="nav-app-tag">{it["tag"]}</span>\n'
            f'      </a>'
        )
    return '\n'.join(out).lstrip()


def render_nav_links(items):
    out = [f'      <a href="{it["href"]}">{it["label"]}</a>' for it in items]
    return '\n'.join(out).lstrip()


def render_m_showcase(items):
    out = []
    for it in items:
        out.append(
            f'      <a href="{it["href"]}" class="m-nav-app">\n'
            f'        <span class="m-name"><span class="m-emoji">{it["emoji"]}</span>{it["name"]}</span>\n'
            f'        <span class="m-tag">{it["tag"]}</span>\n'
            f'      </a>'
        )
    return '\n'.join(out).lstrip()


def render_m_links(items):
    out = [f'      <a href="{it["href"]}">{it["label"]}</a>' for it in items]
    return '\n'.join(out).lstrip()


RENDERERS = {
    'nav': {
        '{{SHOWCASE}}':  render_nav_showcase,
        '{{RESOURCES}}': render_nav_links,
        '{{SOURCE}}':    render_nav_links,
    },
    'm-nav': {
        '{{SHOWCASE}}':  render_m_showcase,
        '{{RESOURCES}}': render_m_links,
        '{{SOURCE}}':    render_m_links,
    },
}


def render_template(ns: str, data: dict) -> str:
    raw = NAV_TEMPLATE_PATHS[ns].read_text()
    raw = raw.replace('{{SHOWCASE}}',  RENDERERS[ns]['{{SHOWCASE}}'](data['showcase']))
    raw = raw.replace('{{RESOURCES}}', RENDERERS[ns]['{{RESOURCES}}'](data['resources']))
    raw = raw.replace('{{SOURCE}}',    RENDERERS[ns]['{{SOURCE}}'](data['source']))
    return raw.strip()


def main() -> int:
    if not DATA_PATH.exists():
        print(f'missing {DATA_PATH.relative_to(ROOT)}', file=sys.stderr)
        return 1
    data = json.loads(DATA_PATH.read_text())
    for k in ('showcase', 'resources', 'source'):
        if k not in data:
            print(f'_nav-data.json missing key: {k}', file=sys.stderr)
            return 1

    templates = {ns: render_template(ns, data) for ns in NAV_TEMPLATE_PATHS}

    updated = scanned = 0
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
            text = path.read_text()
            new_text = text
            for ns, pattern in NAV_PATTERNS.items():
                if pattern.search(new_text):
                    new_text = pattern.sub(lambda _m, t=templates[ns]: t, new_text, count=1)
            if new_text != text:
                path.write_text(new_text)
                updated += 1
                print(f'  updated {path.relative_to(ROOT)}')

    print(f'[sync-nav] {updated} of {scanned} files updated from _nav-data.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
