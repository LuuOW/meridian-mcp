#!/usr/bin/env bash
# Assemble the shared-origin static site at site/dist from the canonical
# sources in mcp/_lib/ and helix/. Single source of truth lives in those
# directories; this script just lays them out under one origin.
#
# Usage:
#   bash site/build.sh
#   wrangler pages deploy site/dist --project-name=meridian-shared
#
# site/dist is gitignored; rebuild on every deploy.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"

rm -rf "$DIST"
mkdir -p "$DIST/_lib" "$DIST/helix" "$DIST/lens" "$DIST/lens/assets" \
         "$DIST/miniapp" "$DIST/miniapp/vision-lab"

# Browser-side _lib modules. core.mjs is server-side. orbital.mjs /
# tokenize.mjs / systems.mjs are pure JS and reusable in browser too —
# routed via /_lib/route-task.mjs which does in-browser candidate gen
# + local orbital classification (replaces cf-worker for /miniapp/).
for f in models.mjs edge-inference.mjs sw-models.mjs route-task.mjs \
         orbital.mjs tokenize.mjs systems.mjs; do
  cp "$REPO/mcp/_lib/$f" "$DIST/_lib/$f"
done

# helix app (no scripts/, those run server-side once).
cp "$REPO/helix/index.html" "$DIST/helix/index.html"
cp "$REPO/helix/app.mjs"    "$DIST/helix/app.mjs"

# lens app — index.js / vlm.mjs / init.js / meridian-route.mjs + assets.
# No sw.js here; the root /sw.js handles HF CDN pinning for every path.
cp "$REPO/lens/index.html"        "$DIST/lens/index.html"
cp "$REPO/lens/index.js"          "$DIST/lens/index.js"
cp "$REPO/lens/init.js"           "$DIST/lens/init.js"
cp "$REPO/lens/vlm.mjs"           "$DIST/lens/vlm.mjs"
cp "$REPO/lens/meridian-route.mjs" "$DIST/lens/meridian-route.mjs"
cp "$REPO/lens/assets/"*           "$DIST/lens/assets/"

# Lens uses __BUILD_SHA__ as a cache-bust query on its module imports
# (./index.js?v=__BUILD_SHA__ etc). Replace at build time so a new deploy
# busts the browser HTTP cache for those modules.
COMMIT="$(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo local)"
for f in "$DIST/lens/index.html" "$DIST/lens/index.js"; do
  sed -i.bak "s/__BUILD_SHA__/$COMMIT/g" "$f" && rm "$f.bak"
done

# miniapp + vision-lab — moved off ask-meridian.uk (which proxied to
# GH Models / Llama-3.3-70B) onto the shared origin running Llama-3.2-3B
# in-browser via /_lib/route-task.mjs.
for f in index.html _md.js api.js app.js ar-mode.js mini-galaxy.js \
         physics-panel.js miniapp.css; do
  cp "$REPO/miniapp/$f" "$DIST/miniapp/$f"
done
for f in index.html lab.css lab.js manifest.webmanifest; do
  cp "$REPO/miniapp/vision-lab/$f" "$DIST/miniapp/vision-lab/$f"
done

# sw.js MUST live at the origin root so its scope is "/" — covers every
# app path. Per-app sw.js under /helix/ or /lens/ would only intercept
# requests under those subpaths.
cp "$REPO/helix/sw.js"      "$DIST/sw.js"

# Minimal landing — redirects to /helix/ until more apps are wired in.
cat > "$DIST/index.html" <<'EOF'
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>meridian</title>
<style>body{background:#0a0d14;color:#e5e7eb;font:15px/1.5 system-ui;padding:48px 20px;text-align:center}a{color:#22d3ee;display:block;margin:8px}</style>
</head><body>
<h1 style="font-size:28px;margin:0 0 24px">◎ meridian</h1>
<a href="/helix/">helix — therapeutic protein recommender</a>
<a href="/lens/">lens — WebXR vision lab</a>
<a href="/miniapp/">miniapp — orbital task router (in-browser Llama-3.2-3B)</a>
<a href="/miniapp/vision-lab/">vision-lab — SmolVLM camera demo</a>
</body></html>
EOF

# Host-aware redirect from legacy lens.ask-meridian.uk → /lens/ is
# handled by a zone-level Cloudflare Single Redirect rule (set via
# Rulesets API on the ask-meridian.uk zone). Pages _redirects with
# host-matching turned out to be unreliable for cross-host rewrites.
# Rule id: 45afee9ff83547b287b3a4e5991f754e

# Deploy-verification probe (matches lens pattern).
printf '{"built_at":"%s","commit":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT" > "$DIST/healthz.json"

echo "[build] $DIST ready ($(find "$DIST" -type f | wc -l | tr -d ' ') files)"
