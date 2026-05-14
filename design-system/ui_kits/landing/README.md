# Landing UI kit — ask-meridian.uk

Marketing surface for Meridian. Recreated from `landing/style.css` + `landing/index.html` in `LuuOW/meridian-mcp`. Includes the full hero with orbital SVG diagram, fleet grid, stats strip, features, how-it-works, pricing, and the final CTA.

## Files

- `index.html` — full page, top to bottom
- `Nav.jsx` — sticky nav (shared shape with miniapp)
- `Hero.jsx` — eyebrow + headline + lead + CTAs + animated orbital SVG behind
- `FleetGrid.jsx` — the "Live properties on this domain" card grid
- `StatsStrip.jsx` — 4-column number band
- `FeaturesGrid.jsx` — 3 feature cards with neon-ring hover halos
- `HowItWorks.jsx` — 3-step explainer with circular step-numbers
- `PricingGrid.jsx` — three-tier pricing with the featured plan ringed in conic gradient
- `CtaFinal.jsx` — closing section
- `Footer.jsx` — minimal foot
- `landing.css` — extracted styles

The hero's interactive `--cursor-x/--cursor-y` halo is implemented (move your mouse over the hero). The animated SVG ring system uses real SMIL `<animateTransform>` straight from upstream.
