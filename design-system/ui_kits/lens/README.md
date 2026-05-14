# Lens UI kit — WebXR Vision Lab

The headset-side surface. Vision-language model in browser, candidates orbiting in real space. Point a controller at an object, pull the trigger, the model describes what it sees.

Live at `meridian.ask-meridian.uk/lens/`. Source: `lens/index.html` + `lens/index.js` (68 KB three.js + iwer scene) + `lens/vlm.mjs` (transformers.js client) in `LuuOW/meridian-mcp`.

## What's here

This kit recreates the **gate page** — the pre-XR screen the user sees before entering the headset. The actual three.js / WebXR scene is not recreated (you can't preview it outside a headset).

The gate carries:
- Eyebrow chip with the brand's distinctive warm-amber accent (the lens app's specific accent — see Visual notes below)
- Headline using a custom gradient (amber → violet) rather than the standard meridian gradient
- Capability checklist — WebXR, WebGL, controllers, hand tracking, network
- Model-source line (operator-paid GPT-4o-mini, no client download)
- Module-load progress bar (the real app downloads ~12 MB of three.js + iwer + troika + gsap from esm.sh on first run)
- Enter VR button (warm-amber gradient + neon halo) and a "skip with mock answers" ghost button

## Visual notes

**This product has its own accent color — warm amber #ffa276.** It's the only Meridian surface that breaks from the violet-primary palette, and it's intentional: orange feels right for a lens / camera / vision context. Everything else (page wash, mono font, eyebrow shape, neon halo treatment) stays brand-consistent.

The button gradient is amber → orange (180°) instead of the standard violet → violet-deep. The neon halo cycle still uses the multi-stop violet/cyan/mint/pink — that's the brand signature regardless of the local accent.
