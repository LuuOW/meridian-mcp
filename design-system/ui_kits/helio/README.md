# Helio UI kit — solar irradiance dashboard

Live solar-irradiance triangulator. PSP (Parker Solar Probe) measures the Sun directly; JWST observes solar-system bodies in reflected sunlight. Cross-correlate the two signal streams to forecast 24 h irradiance delivered to each body.

Live at `ask-meridian.uk/helio`. Source: `helio-mirror/` (Python pipeline, 14 scripts) + `landing/helio/index.html` (the rendered dashboard).

## What's here

- **6-stage pipeline strip** — pull · register · detect · coincide · **calibrate (running)** · forecast (queued). Done/running/pending visual states.
- **Per-body irradiance cards** — Mercury · Mars · Jupiter · Saturn, each with the current W/m² reading, 24 h-forecast delta arrow, 24 h sparkline, and PSP-correlation + event-count metadata.
- **Recent coincidences table** — 14 cross-matched PSP↔JWST events with B-field, plasma, SEP, and JWST filter signatures, time lags, correlation coefficients.
- **Caveat callout** at the bottom — flags the heuristic reflectance calibration honestly.

## What's faked
Sparkline data and event timestamps are hand-authored. In production this whole page reads `forecast/latest.json` from `luuow/meridian-helio-mirror` on HuggingFace.

The color story: warm bodies (Mercury, Mars) are amber/rose, gas giants are violet/cyan — keeps the radial heat metaphor without breaking from the violet/cyan/mint brand palette.
