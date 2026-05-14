# Miniapp UI kit — Task Orbit

The flagship Meridian demo: type a task, get five ranked candidates with celestial classes, click one to see why. Hosted at **ask-meridian.uk/miniapp**.

This kit is a faithful visual recreation of `miniapp/index.html` + `miniapp/miniapp.css` + `miniapp/mini-galaxy.js` from `LuuOW/meridian-mcp`. The orbital canvas is simplified — orbit positions are real but the full 3D tilt + zoom interaction from the production file is omitted (see `mini-galaxy.js` upstream if you need it).

## What's in here

- `index.html` — the full miniapp scaffold + a small click-thru: empty state → loading → results → side panel
- `Nav.jsx` — sticky top nav, brand + apps menu + cmd-k trigger + GitHub link + burger
- `AskCard.jsx` — eyebrow/headline/textarea with the rotating neon-ring frame, example chips, primary CTA, AR pill
- `MetaBar.jsx` — quota pill + model-picker pill
- `MiniGalaxy.jsx` — canvas orbital visualisation (2D mode, simplified)
- `ResultsList.jsx` — ranked list with class chips + score badges
- `CandidatePanel.jsx` — slide-in right panel with score breakdown + decision rule + markdown body

## How to use

Open `index.html` to see the canonical "above the fold" view. Click "Find compatible candidates →" or any example chip to trigger a fake 1.2 s routing animation, then explore the results. Click any result row to open the candidate side panel.
