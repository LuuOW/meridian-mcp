---
title: Meridian Stellar Explorer
emoji: ☀️
colorFrom: indigo
colorTo: yellow
sdk: gradio
sdk_version: 5.7.1
app_file: app.py
pinned: false
license: mit
short_description: JWST → sun-archetype projector for Meridian harvest.
---

# Meridian Stellar Explorer

Interactive companion to the [Stellar Harvest-Forecast](https://ask-meridian.uk/blog/stellar-harvest-forecast/) blog post.

Pick a JWST observation (target × instrument × order) and see:

- the sun-archetype the projection assigns it to (k=6 GMM, fit on 621 PSP feature vectors)
- the predicted 48 h harvest drift via the matched archetype's specialist
- the JWST spectral fingerprint (λ_peak μm, φ, p_asym, a) and the matching PSP-sun centroid (λ_peak Hz, …)

All data is loaded live from [`luuow/meridian-stellar-cache`](https://huggingface.co/datasets/luuow/meridian-stellar-cache). The Space holds no model state.

## Caveats

- Cross-domain z-projection — we assume "where this JWST target sits relative to its peers maps to where the corresponding PSP window sits relative to its peers". This is a strong assumption.
- 3 targets (TRAPPIST-1, WASP-39, WASP-96) is preliminary, not statistical.
- The Meridian forecaster was trained and validated on PSP only. JWST projections are a demonstration that the framework extends, not a calibrated forecaster for any specific star.

## Code

Source: [github.com/LuuOW/meridian-mcp/tree/main/stellar/space](https://github.com/LuuOW/meridian-mcp/tree/main/stellar/space)
