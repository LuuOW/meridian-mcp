---
name: docs-strategy
description: Documentation architecture, information hierarchy, style guides, versioning strategy, and cross-team documentation governance for production software projects
---

# docs-strategy

Authoritative patterns for building and maintaining documentation systems — from single-product READMEs to multi-tenant doc sites, living style guides, and versioned reference portals.

## Information Architecture

Define the documentation tree before writing a single page. Group by audience intent, not by your internal team structure.

```
docs/
├── guides/           # Task-oriented: "How do I...?"
│   ├── quickstart.md
│   ├── authentication.md
│   └── deployment.md
├── reference/        # Lookup: "What does X do exactly?"
│   ├── api/
│   ├── cli/
│   └── config-schema.md
├── concepts/         # Mental models: "Why does this work the way it does?"
│   ├── architecture.md
│   └── data-model.md
├── tutorials/        # Learning-oriented: "Walk me through end-to-end"
│   └── build-your-first-widget.md
└── changelog/        # Temporal: "What changed and when?"
    └── CHANGELOG.md
```

**DITA/Divio quadrant rule**: Every page belongs to exactly one quadrant — tutorial, how-to, reference, or explanation. Mixed pages confuse readers and break search ranking.

## Style Guide Foundations

Establish these before any other doc work. Retrofit is 10× harder.

```markdown
# Documentation Style Guide

## Voice and Tone
- Active voice. "Run the command" not "The command should be run."
- Second person. "You configure X" not "The user configures X."
- Present tense. "Returns a 404" not "Will return a 404."

## Naming
- Product name: always "Acme" (never "ACME", "acme", or "the platform")
- Code terms: always backtick-wrapped — `config.yaml`, `run()`, `--flag`
- Files and paths: always backtick-wrapped — `/etc/app/config`

## Code Blocks
- Always specify the language for syntax highlighting
- Include a comment on the first line if context is non-obvious
- Prefer runnable examples over pseudocode

## Callout Types
> **Note:** Supplementary information that may be useful.
> **Warning:** Risk of data loss or breaking change.
> **Tip:** Shortcut or optimization the reader may not know.

## Headings
- H1: page title only (one per page)
- H2: major sections navigated from TOC
- H3: subsections within a section
- Never skip levels (H1 → H3 without H2)
```

## Versioning Strategy

Choose one model per product and stick to it. Mixing models breaks search engines and reader trust.

```markdown
## Versioning Models

### "Latest only" (default for most projects)
- Single `main` branch, docs always reflect HEAD
- Breaking changes: add a prominent banner, not a new doc tree
- Deprecations: keep the old page with a redirect notice for 2 major versions

### "Version-pinned" (APIs with long-term contracts, SDKs)
- Separate docs branch per major version: `docs/v2`, `docs/v3`
- CI publishes each branch to `/v2/`, `/v3/`, `/latest/`
- `latest` always redirects to the highest stable version

### "Changelog-as-record" (internal tools, CLIs)
- No versioned doc site — CHANGELOG.md is the single source of truth
- Docs reflect only the current release
- Breaking changes documented in CHANGELOG under "## Migration"
```

## Docs-as-Code Pipeline

Treat documentation with the same rigour as application code.

```yaml
# .github/workflows/docs.yml
name: Docs CI

on:
  pull_request:
    paths: ["docs/**", "*.md"]
  push:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint markdown
        uses: DavidAnson/markdownlint-cli2-action@v16
        with:
          globs: "**/*.md"

      - name: Check links
        uses: lycheeverse/lychee-action@v1
        with:
          args: --no-progress "**/*.md"

      - name: Spell check
        uses: streetsidesoftware/cspell-action@v6
        with:
          files: "**/*.md"

  build:
    needs: lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build doc site
        run: |
          pip install mkdocs mkdocs-material
          mkdocs build --strict
```

## Ownership and Review Policy

```markdown
# CODEOWNERS (docs paths)
docs/reference/api/      @team-platform     # API team owns reference
docs/guides/             @team-dx           # DevEx team owns how-tos
docs/concepts/           @team-architecture # Arch team owns concepts
*.md                     @team-dx           # DX reviews all markdown by default
```

**Review checklist for docs PRs:**
- [ ] Audience is clear (who is this for?)
- [ ] One quadrant per page (tutorial / how-to / reference / explanation)
- [ ] All code blocks tested and runnable
- [ ] No dead links (`lychee` passes)
- [ ] Style guide rules followed
- [ ] SEO: H1 matches `<title>`, meta description present

## Doc Site Tooling Decision Matrix

| Tool | Best for | Avoid when |
|------|----------|------------|
| **MkDocs + Material** | Python projects, internal portals | Need React components in docs |
| **Docusaurus** | OSS projects, versioned API docs | Very small project (overkill) |
| **Starlight (Astro)** | Performance-sensitive public docs | Team unfamiliar with Astro |
| **GitBook** | Non-technical teams writing docs | Needing full CI/CD control |
| **Plain GitHub wiki** | Internal runbooks, incident notes | Public-facing docs |
| **VitePress** | Vue/Vite ecosystem projects | Non-JS teams |

## Metrics and Health Checks

Track doc quality as you track code quality.

```python
# doc_health.py — run monthly or in CI
import subprocess, json, pathlib

def count_orphaned_pages(docs_dir="docs/"):
    """Pages not linked from any navigation or other page."""
    # ... grep for links, diff against file list
    pass

def avg_time_since_last_edit(docs_dir="docs/"):
    result = subprocess.run(
        ["git", "log", "--format=%ar", "--", docs_dir],
        capture_output=True, text=True
    )
    # Parse relative dates ...

def pages_without_headings():
    for path in pathlib.Path("docs/").rglob("*.md"):
        content = path.read_text()
        if not any(line.startswith("# ") for line in content.splitlines()):
            yield path
```

**Health KPIs:**
- Orphaned pages: 0
- Pages not edited in 6+ months: < 10% of total
- Broken links: 0 in CI
- Pages without an H1: 0
- Mean time to update after code change: < 2 sprints

## Common Mistakes

- Writing docs *after* the feature ships — write the concept page before you write the code
- Putting troubleshooting content in the wrong quadrant (it belongs in how-to, not reference)
- Duplicating content instead of linking — duplication drifts, links don't lie
- No `noindex` on staging doc sites — search engines index drafts and rank them above production
- Merging docs PRs without running linkcheck — dead links accumulate silently
