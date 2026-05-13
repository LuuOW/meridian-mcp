# binance-proxy

Tiny HTTP proxy that bridges a CF Worker (`finance-mcp`) to Binance via Bright
Data. Cloudflare Workers' egress IPs are geo-blocked by Binance, and CF
Workers' `cloudflare:sockets.startTls()` can't override SNI after a CONNECT,
so this thin Fly machine handles the BD CONNECT-tunnel + TLS upgrade on the
Worker's behalf. Bright Data hands us a single static residential-grade exit
IP that we whitelist on the Binance API key.

## Architecture

```
finance-mcp Worker
   ↓ HTTPS + X-Proxy-Secret
this proxy on Fly (any region — egress IP doesn't matter, we're tunneling)
   ↓ HTTP CONNECT via https-proxy-agent
brd.superproxy.io:33335 (Bright Data)
   ↓ static exit IP (whitelist this on Binance)
api.binance.com / fapi.binance.com
```

## Deploy

```bash
# 1. Install flyctl (one-time)
curl -L https://fly.io/install.sh | sh
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"

# 2. Authenticate
flyctl auth login

# 3. From this directory, create the app + deploy
cd /Users/lkempe/code/binance-proxy
flyctl apps create binance-proxy-lkempe --org personal

# 4. Set secrets — never commit these
flyctl secrets set \
  PROXY_SECRET="$(openssl rand -hex 32)" \
  BRIGHTDATA_USER="brd-customer-<id>-zone-<zone>" \
  BRIGHTDATA_PASS="<zone password>"

# 5. Deploy
flyctl deploy --remote-only --ha=false

# → https://binance-proxy-lkempe.fly.dev
```

## What it does

- `GET /healthz` → 200 OK (Fly health probe)
- Any other path → forwarded to `api.binance.com` (or `fapi.binance.com` for
  paths starting `/fapi/`) **through** Bright Data's CONNECT proxy.
- Requires `X-Proxy-Secret` header matching `PROXY_SECRET`. Otherwise 403.
- Strips Fly-injected headers (`X-Forwarded-*`, `Fly-*`) before forwarding —
  Binance's CloudFront WAF flags them and returns 403.

## Update the Worker after deploy

```bash
echo "https://binance-proxy-lkempe.fly.dev" | npx wrangler secret put BINANCE_PROXY_URL
echo "<the PROXY_SECRET you set above>" | npx wrangler secret put BINANCE_PROXY_SECRET
```

The worker's `binance.ts` falls back to direct Binance when these aren't set.

## Sizing

- 1 shared CPU, 256 MB RAM. Fly's free trial machines stop after 5 min idle;
  first request after idle takes ~2–3 s to wake. Add a card on Fly if cold
  starts are a problem (~$2/mo for an always-on micro VM).
