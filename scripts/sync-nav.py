#!/usr/bin/env python3
"""Sync nav blocks across every browser-facing HTML in the monorepo,
from two templates kept under landing/:

  landing/_nav.html    — canonical .nav  variant (landing + helix + miniapp)
  landing/_m-nav.html  — canonical .m-nav variant (lens + photon-route)

A single source of truth per namespace. Run before any deploy that
touches a page with a nav:

    python3 scripts/sync-nav.py

Surfaces walked:
  - landing/                       → GH Pages on ask-meridian.uk
  - helix/, miniapp/               → CF Pages on meridian.ask-meridian.uk/*
  - lens/                          → CF Pages on meridian.ask-meridian.uk/lens
  - photon-route/pages/            → HF Space on photon.ask-meridian.uk
                                     (also lives in the standalone repo
                                      — push there too after running)

Each file is detected by which nav class it contains and patched with
the matching template. Files are touched once with a non-greedy regex,
DOTALL, so we don't accidentally chew through later <nav> elements
in the body.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT      = Path(__file__).resolve().parent.parent
LANDING   = ROOT / 'landing'

# Search roots (every directory whose HTML may carry a synced nav).
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


def load_template(p: Path) -> str:
    if not p.exists():
        print(f'missing template: {p.relative_to(ROOT)}', file=sys.stderr)
        sys.exit(1)
    body = p.read_text().strip()
    if not body.startswith('<nav') or not body.endswith('</nav>'):
        print(f'template {p.relative_to(ROOT)} must be a single <nav>…</nav> block',
              file=sys.stderr)
        sys.exit(1)
    return body


def main() -> int:
    templates = {k: load_template(v) for k, v in NAV_TEMPLATE_PATHS.items()}

    updated = scanned = 0
    seen_files: set[Path] = set()
    for surface in SURFACES:
        if not surface.exists():
            continue
        for path in sorted(surface.rglob('*.html')):
            if path.name.startswith('_'):                # skip templates
                continue
            if path in seen_files:
                continue
            seen_files.add(path)
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

    print(f'[sync-nav] {updated} of {scanned} files updated')
    return 0


if __name__ == '__main__':
    sys.exit(main())
