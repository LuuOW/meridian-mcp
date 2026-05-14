#!/usr/bin/env python3
"""Single-source nav sync across every browser-facing HTML in the monorepo.

Edit these to change the nav anywhere:
  landing/_nav-data.json   — showcase / resources / source items
  landing/_nav.html        — template with {{SHOWCASE}} {{RESOURCES}} {{SOURCE}}

Lens + photon-route used to ship their own .m-* nav namespace; they've
been renamed in-place to the canonical .nav classes so one template
covers every surface now.

Surfaces walked:
  - landing/                       → GH Pages on ask-meridian.uk
  - helix/, miniapp/               → CF Pages on meridian.ask-meridian.uk/*
  - lens/                          → CF Pages on meridian.ask-meridian.uk/lens
  - photon-route/pages/            → HF Space on photon.ask-meridian.uk
                                     (also rsync + push to standalone)

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


def render_template(data: dict) -> str:
    raw = TEMPLATE.read_text()
    raw = raw.replace('{{SHOWCASE}}',  render_showcase(data['showcase']))
    raw = raw.replace('{{RESOURCES}}', render_links(data['resources']))
    raw = raw.replace('{{SOURCE}}',    render_links(data['source']))
    return raw.strip()


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

    rendered = render_template(data)
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
            if not NAV_RE.search(text):
                continue
            new_text = NAV_RE.sub(lambda _m: rendered, text, count=1)
            if new_text != text:
                path.write_text(new_text)
                updated += 1
                print(f'  updated {path.relative_to(ROOT)}')

    print(f'[sync-nav] {updated} of {scanned} files updated from _nav-data.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
