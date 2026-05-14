# Helix UI kit — proteins-as-star-systems

Vision/text → top therapeutic protein candidates rendered as star systems. Each recommended protein gets its own world: protein at center, its real chemical compounds + ligands in orbit.

Live at `meridian.ask-meridian.uk/helix/`. Source: `helix/index.html` + `helix/helix.css` + `helix/app.mjs` in `LuuOW/meridian-mcp`.

## What's recreated
- Vertical-scroll universe of star-system cards (one per protein)
- Each card: rank badge · protein name · UniProt accession · class chip · centered "protein star" with orbiting compounds · score pills · rationale
- Sticky input card with textarea + photo upload + recommend CTA
- Animated SVG compounds (real ligand names: TrkA, p75, NGF-β, EGFR, IGF-1R, sub-P) drifting on dashed orbits

## What's simplified
- **No Mol* viewer.** The real app embeds `molstar` to render full 3D protein structures from PDB. I replaced the central viewport with an animated SVG nebula + a stylised polypeptide squiggle inside a glowing core. Real version: lazy-loads `molstar` (~5MB) only on first card mount.
- Fullscreen / HUD / live atom selection are omitted — the production app supports clicking a residue to get a 2D ball-and-stick render of that ligand.

## Sample state
The kit ships with a fake corneal-abrasion query and 3 hand-authored proteins (NGF, EGF, IGF-1) with real UniProt IDs and plausible therapeutic rationale. Click "recommend" to trigger the routing animation.
