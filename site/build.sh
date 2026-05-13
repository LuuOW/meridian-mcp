#!/usr/bin/env bash
# Assemble the static site at site/dist for Cloudflare Pages deploy.
# Single origin meridian.ask-meridian.uk serves four browser apps:
# helix, lens, miniapp, miniapp/vision-lab. All inference happens
# server-side at mcp.ask-meridian.uk/v1/{route,vision,helix} via the
# cf-worker → GH Models. No models cached client-side.
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
mkdir -p "$DIST/helix" "$DIST/lens" "$DIST/lens/assets" \
         "$DIST/miniapp" "$DIST/miniapp/vision-lab"

cp "$REPO/helix/index.html"    "$DIST/helix/index.html"
cp "$REPO/helix/app.mjs"       "$DIST/helix/app.mjs"
cp "$REPO/helix/helix.css"     "$DIST/helix/helix.css"
cp "$REPO/helix/molecules.mjs" "$DIST/helix/molecules.mjs"

cp "$REPO/lens/index.html"        "$DIST/lens/index.html"
cp "$REPO/lens/index.js"          "$DIST/lens/index.js"
cp "$REPO/lens/init.js"           "$DIST/lens/init.js"
cp "$REPO/lens/vlm.mjs"           "$DIST/lens/vlm.mjs"
cp "$REPO/lens/meridian-route.mjs" "$DIST/lens/meridian-route.mjs"
cp "$REPO/lens/assets/"*           "$DIST/lens/assets/"

# Cache-bust: replace __BUILD_SHA__ on every app file that uses it.
COMMIT="$(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo local)"
for f in "$DIST/lens/index.html" "$DIST/lens/index.js" \
         "$DIST/helix/index.html"; do
  sed -i.bak "s/__BUILD_SHA__/$COMMIT/g" "$f" && rm "$f.bak"
done

for f in index.html _md.js api.js app.js ar-mode.js mini-galaxy.js \
         physics-panel.js miniapp.css; do
  cp "$REPO/miniapp/$f" "$DIST/miniapp/$f"
done
for f in index.html lab.css lab.js manifest.webmanifest; do
  cp "$REPO/miniapp/vision-lab/$f" "$DIST/miniapp/vision-lab/$f"
done

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
<a href="/miniapp/">miniapp — orbital task router</a>
<a href="/miniapp/vision-lab/">vision-lab — snap-and-ask camera demo</a>
</body></html>
EOF

# Legacy lens.ask-meridian.uk → /lens/ is handled at the zone via a CF
# Single Redirect Rule (id 45afee9ff83547b287b3a4e5991f754e). No
# Pages-level _redirects needed.

printf '{"built_at":"%s","commit":"%s"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$COMMIT" > "$DIST/healthz.json"

echo "[build] $DIST ready ($(find "$DIST" -type f | wc -l | tr -d ' ') files)"
