# Wiring `stellar.ask-meridian.uk`

The dashboard is hosted at `ask-meridian.uk/stellar/` via the existing GitHub Pages deploy. To make `stellar.ask-meridian.uk` resolve to the same content, do the two steps below in Cloudflare.

## Step 1 — DNS CNAME

```
Type:    CNAME
Name:    stellar
Target:  stellar-proxy.<your-account>.workers.dev   (or directly luuow.github.io,
                                                     see Step 2 alternative)
Proxy:   ☁️  Proxied
TTL:     Auto
```

## Step 2 — Cloudflare Worker route (recommended path)

```bash
cd cf-worker
# Uncomment the [[routes]] block in wrangler.stellar.toml first.
wrangler deploy --config wrangler.stellar.toml
```

The worker (`cf-worker/stellar-proxy.mjs`) is intentionally thin: it forwards every `stellar.ask-meridian.uk/*` request to `ask-meridian.uk/stellar/*`, preserving status / headers / range responses. It adds a single `x-stellar-proxy` debug header so it's clear from the response which path served.

## Alternative — pure DNS (no worker)

If you don't want to run a worker, you can:

1. Create a separate GitHub Pages repo whose only purpose is the stellar subdomain (e.g. `luuow/stellar-subdomain`).
2. Set its CNAME file content to `stellar.ask-meridian.uk`.
3. Point a Cloudflare CNAME `stellar` → `luuow.github.io` (proxy off so GH Pages can verify the custom domain).

This is more moving parts than the worker, and decouples the dashboard from the rest of the site (we'd lose shared CSS, nav, etc.). Not recommended for this case.

## After deploy

Verify with:

```bash
curl -I https://stellar.ask-meridian.uk/
# expect HTTP/1.1 200 + x-stellar-proxy: ask-meridian.uk/stellar
```
