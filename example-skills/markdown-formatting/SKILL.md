---
name: markdown-formatting
description: Clean, consistent markdown output for LLM-generated content — headings, lists, code fences, tables, and front matter.
---

# markdown-formatting

## Heading hierarchy
- Use only one H1 (`#`) per document
- H2 for major sections, H3 for subsections; never skip levels

## Code fences
- Always label the language: ` ```python `, ` ```json `, ` ```bash `
- Put long output under a details/summary block if >40 lines

## Tables
- Pipe-style with alignment colons: `|:--|:-:|--:|`
- Keep cells short; link to appendix for long content
