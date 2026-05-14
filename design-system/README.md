# Meridian Design System

Canonical reference for Meridian's visual language: tokens, type scale, components, motion, and brand assets. The tokens here mirror the values already in `landing/style.css` and `miniapp/miniapp.css` — this directory pulls them into one importable surface and adds full reference kits for each app.

Dark-mode first. No light variant.

## Layout

- **`tokens.css`** — single-file CSS custom properties + semantic type classes (`.t-display`, `.t-h1`, `.t-eyebrow`, `.t-grad`, …) + shared `@keyframes` (`neonRotate`, `gradShift`, `liveDotPing`). Drop into any page with `<link rel="stylesheet" href="/design-system/tokens.css">`.
- **`preview/`** — 49 standalone HTML pages, one per design primitive. Open any file directly in a browser; tokens are inlined so each preview is self-contained.
- **`ui_kits/`** — per-surface reference kits (JSX + HTML + CSS) for: `landing`, `miniapp`, `docs`, `helio`, `helix`, `lens`, `photon-router`.
- **`assets/`** — brand SVGs (Meridian logo, partner marks) and product cover art / screenshots.

## Preview index

| Category | Files |
|---|---|
| **Color** | `colors-backgrounds`, `colors-brand`, `colors-text`, `colors-gradients`, `colors-star-systems`, `colors-celestial-classes` |
| **Type** | `type-scale`, `type-families`, `type-eyebrows`, `type-gradient-headline`, `type-in-context` |
| **Spacing / elevation** | `spacing-scale`, `spacing-radii`, `spacing-shadow-system`, `spacing-neon-ring` |
| **Motion** | `motion-ease-out`, `motion-ease-spring`, `motion-grad-shift`, `motion-live-ping`, `motion-neon-rotate` |
| **Celestial system** | `celestial-matrix`, `celestial-orbits`, `celestial-rules` |
| **Components** | `components-buttons`, `components-cmdk-palette`, `components-input-frame`, `components-meta-bar`, `components-nav-app-row`, `components-result-row`, `components-score-breakdown`, `components-stat-strip`, `components-physics-radar`, `components-ar-stage`, `components-example-chips` |
| **States** | `state-empty`, `state-error`, `state-loading`, `state-no-results` |
| **Brand** | `brand-logo`, `brand-poster`, `brand-fleet-covers`, `brand-mini-galaxy`, `brand-orbital-diagram`, `brand-gravity-well`, `brand-code-snippet`, `brand-social-og`, `brand-social-github`, `brand-social-twitter` |

## UI kits

| Kit | Surface | Highlights |
|---|---|---|
| `ui_kits/landing/` | `ask-meridian.uk/` marketing | Hero, FleetGrid, StatsStrip, FeaturesGrid, HowItWorks, PricingGrid, CtaFinal, Nav |
| `ui_kits/miniapp/` | `ask-meridian.uk/miniapp` | AskCard, ResultsList, MetaBar, CandidatePanel, MiniGalaxy, Nav |
| `ui_kits/docs/` | `ask-meridian.uk/docs` | Sidebar, Article, Callout, CodeBlock, OnThisPage |
| `ui_kits/helio/` | Helio mirror reference page | Single-page index |
| `ui_kits/helix/` | Therapeutic-protein recommender shell | Single-page index |
| `ui_kits/lens/` | Vision-lab / lens UI | Single-page index |
| `ui_kits/photon-router/` | Photon-route docs / demo | Single-page index |

## How to use

**Reference, not runtime.** The live apps (`landing/`, `miniapp/`, `helix/`, `lens/`, `photon-route/`, `helio-mirror/`) already ship their own bundled styles. Treat this directory as the source-of-truth for visual decisions; pull from it when:

1. Adding a new surface — start from the closest `ui_kits/` kit.
2. Aligning an existing surface — diff its tokens against `tokens.css`; the file is the canonical set.
3. Designing a new component — check `preview/` first; the primitives there are the building blocks.

When a value here diverges from a live app's CSS, the live app wins for that release but a follow-up should re-sync. Keep the system one source of truth.

## Brand foundations (quick reference)

- **Page background**: `var(--bg-page)` — three stacked radial-gradients + linear fade.
- **Primary accent**: `--accent` (`#a78bfa`, neon-violet).
- **Headline gradient**: `--grad-hero` (violet → cyan → mint).
- **Body type**: Inter; **mono**: JetBrains Mono.
- **Base spacing unit**: 4 px (`--s-1`); section rhythm: `var(--section-y)`.
- **Signature motion**: `neonRotate` (8–14 s conic spin behind cards), `liveDotPing` (1.6 s ping on live status), `gradShift` (8 s hero-gradient sweep).
- **Celestial classes**: `planet` / `moon` / `trojan` / `asteroid` / `comet` / `irregular` — see `preview/celestial-rules.html` for the argmax scoring rules.
