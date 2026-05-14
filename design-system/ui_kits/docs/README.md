# Docs UI kit — ask-meridian.uk/docs

Documentation surface for Meridian. The third top-level kit alongside `landing/` and `miniapp/`.

Sidebar nav, prose width, code block scale, and callout patterns are the things that diverge from the marketing site — that's what this kit exists to capture.

## Files

- `index.html` — full docs page with the orbital sidebar + a real article rendered (the "Connect to Grok" walkthrough)
- `Sidebar.jsx` — collapsible section nav with active-link highlighting
- `Article.jsx` — prose container with the brand's specific h2/h3 + code-block treatment
- `Callout.jsx` — info / warn / success callouts. Replaces the AI-slop "rounded card with colored left border" pattern with the brand's `1px dashed border-violet` + violet wash style.
- `CodeBlock.jsx` — tabbed code blocks (`stdio` / `http`) with the conic-ring border + copy button
- `OnThisPage.jsx` — right-rail TOC with a scroll-spy underline
- `docs.css` — extracted styles

## Notes

The codebase's `landing/docs/` is rendered through the same `landing/style.css` + nav system. I lifted the docs-specific patterns (sidebar, callouts, code tabs) and kept everything else inherited.
