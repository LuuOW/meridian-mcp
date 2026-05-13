#!/usr/bin/env python3
"""Sync the <nav class="nav">…</nav> block across every landing HTML
file from a single template at landing/_nav.html.

The landing site is plain GitHub Pages — no templating engine, no
build step. Every page used to carry its own duplicate copy of the
nav, which is how helix went missing from the burger menu on every
blog post when I only updated landing/index.html.

Run before deploying any landing change:
    python3 scripts/sync-nav.py

The "current page" highlight is handled at runtime by landing/nav.js
based on location.pathname, so the template intentionally contains
no `class="current"` markers.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT     = Path(__file__).resolve().parent.parent / 'landing'
TEMPLATE = ROOT / '_nav.html'
NAV_RE   = re.compile(r'<nav class="nav".*?</nav>', re.DOTALL)


def main() -> int:
    if not TEMPLATE.exists():
        print(f'missing template: {TEMPLATE}', file=sys.stderr)
        return 1
    nav = TEMPLATE.read_text().strip()
    if not nav.startswith('<nav class="nav"') or not nav.endswith('</nav>'):
        print('template must be a single <nav class="nav">…</nav> block', file=sys.stderr)
        return 1

    updated = scanned = 0
    for path in sorted(ROOT.rglob('*.html')):
        if path == TEMPLATE:
            continue
        scanned += 1
        text = path.read_text()
        if not NAV_RE.search(text):
            continue
        # Use a lambda so backslashes in the template aren't interpreted
        # as regex backreferences in re.sub's replacement.
        new_text = NAV_RE.sub(lambda _m: nav, text, count=1)
        if new_text != text:
            path.write_text(new_text)
            updated += 1
            print(f'  updated {path.relative_to(ROOT)}')

    print(f'[sync-nav] {updated} of {scanned} files updated')
    return 0


if __name__ == '__main__':
    sys.exit(main())
