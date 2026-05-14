# Photon Router UI kit — Strawberry Fields retrieval

A continuous-variable (CV) photonic retrieval research artifact. Each document and query is encoded as a small Strawberry Fields program — words contribute squeezing and displacement to alternating bosonic modes, sentence length controls beam-splitter mixing. Retrieval ranks by Gaussian-state fidelity (Banchi-Braunstein-Pirandola).

Live at `photon.ask-meridian.uk` (HF Space, sleeps after 1h). Source: `photon-route/` in `LuuOW/meridian-mcp` + `huggingface.co/spaces/luuow/photon-route`.

## What's here

- Search input with the rotating mask-composited neon ring (using the brand's signature treatment, in cyan rather than violet for this app's research-mode look)
- Backend pill — `gaussian` (Strawberry Fields imports cleanly) vs `stub` (falls back to deterministic hash)
- Ranked result list — title · fidelity score · arXiv ID · year · mode count · snippet · per-document encoding parameters (‖α‖ displacement magnitude, r̄ mean squeezing, BS-θ beam-splitter angle)
- **Wigner function visualization** for the query — the centerpiece of the kit. A 2D phase-space plot showing the squeezed-coherent state as an elliptical "thumbprint" off-center from the origin. Squeezing direction shows as the ellipse rotation; displacement shows as the offset from (0,0); the radial fade shows the Gaussian falloff.
- Compile parameters: cutoff N, BS layer count, BS angles, backend type + compile time
- "Day-1 scaffold" honesty callout flagging that today's encoding is SHA-256-derived placeholder

## Visual notes

This product uses **cyan as the primary accent** (rather than violet) — fits the photonic/optical-physics theme. Eyebrow is cyan, neon ring is cyan-led, search-bar focus is cyan. Pricing comes from the brand palette though, so violet still appears in result-row tags and the secondary radial gradient on the Wigner function.

The Wigner ellipse rotation + offset are the visual punchline — they encode real physics (squeezing rotates the noise distribution; displacement shifts the centroid). If you change the query, in production both transform.
