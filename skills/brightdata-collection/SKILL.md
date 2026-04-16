---
name: brightdata-collection
description: Bright Data collection specialist — dynamic page retrieval, geo-targeted browsing, anti-bot resilient collection, SERP capture, and hard-target fallback for agent research pipelines
---

# brightdata-collection

Use this only when simpler search or extraction paths are insufficient.

## Best Uses

- geo-specific SERP capture
- JavaScript-heavy targets
- anti-bot-protected sites
- browser-rendered collection
- difficult competitor pages that normal HTTP scraping cannot access reliably

## Required Env

- `BRIGHTDATA_API_KEY`

Optional:

- `BRIGHTDATA_ZONE`
- `BRIGHTDATA_COUNTRY`

## Invocation Threshold

Bright Data is not the default. Use it when one of these is true:

- the target requires rendering
- the target is blocked to normal fetch tools
- the task requires region-specific result pages
- the task explicitly needs search-result capture or browser automation

## Collection Rules

- state why Bright Data is required before use
- keep requested geography explicit
- minimize pages collected to reduce cost
- save the exact target pattern when a route succeeds

## Example Task Shapes

- capture US desktop SERP for a keyword
- fetch a React app page that returns empty shells to non-browser clients
- collect pricing pages from a site with aggressive bot defenses

## Avoid

- general source discovery that Exa can handle
- straightforward content extraction from static pages that Firecrawl can handle

## Residential Proxy via Playwright

For browser automation that requires a residential IP (e.g. LinkedIn, which blocks datacenter IPs at the Cloudflare layer), route Playwright through BrightData's residential proxy. **Set the proxy at `browser.newContext()` level — not `chromium.launch()`**. `context.request` (Playwright's APIRequestContext) does not inherit the launch-level proxy and returns 407.

```javascript
const proxy = {
  server:   'http://brd.superproxy.io:22225',
  username: 'brd-customer-hl_XXXXX-zone-ZONE-session-STICKY_ID',
  password: 'ZONE_PASSWORD',
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ proxy });  // ← correct level
// Now both page.goto() and context.request.get() route through the proxy
```

Use a sticky session suffix (`-session-XXXXXXXX`) on the username to keep the same residential IP for the browser context lifetime — important when session cookies are IP-bound.

See `browser-stealth` skill for full patterns: webdriver masking, patchright, csrf-token derivation, and the `page.evaluate(fetch)` fallback.

## Hand-off Rules

- Feed collected URLs or rendered page outputs back into the normal evidence contract.
- If Bright Data becomes the routine answer for a target class, document that class in the calling skill rather than improvising it each time.
