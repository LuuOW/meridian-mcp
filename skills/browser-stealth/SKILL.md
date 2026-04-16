---
name: browser-stealth
description: Browser automation stealth and residential proxy routing — patchright anti-detection, Playwright proxy at correct context level, sticky residential sessions, navigator.webdriver masking, datacenter vs residential IP fingerprinting, and page.evaluate fetch fallback
keywords: ["browser", "stealth", "playwright", "ip", "residential", "proxy", "automation", "routing", "patchright", "anti-detection", "correct", "context", "level", "sticky", "sessions", "navigator"]
orb_class: moon
---

# browser-stealth

Patterns for running Playwright (via patchright) through a residential proxy without triggering bot detection. Covers the critical proxy configuration level bug, sticky session IDs, webdriver masking, and the page.evaluate fetch fallback when context.request can't authenticate through the proxy.

## Patchright vs Playwright

Patchright is a drop-in Playwright fork with stealth patches applied at the Chromium level. Use it for targets with aggressive bot detection.

```bash
npm install -g patchright
npx patchright install chromium --with-deps
```

```javascript
// Replace this:
const { chromium } = require('playwright');

// With this — same API, stealth patches applied:
const { chromium } = require('patchright');
```

## Proxy at Context Level — Not Launch Level

**The most common mistake:** setting proxy at `chromium.launch()` affects page navigation but `context.request` (Playwright's `APIRequestContext`) does NOT inherit it. You get `407 Proxy Authentication Required` on all `context.request.get()` calls.

```javascript
// WRONG — context.request gets 407
browser = await chromium.launch({
  proxy: { server: 'http://proxy:8080', username: 'user', password: 'pass' },
});
context = await browser.newContext({});  // ← no proxy here, context.request fails

// CORRECT — proxy must be on newContext() for context.request to work
browser = await chromium.launch({ /* no proxy here */ });
context = await browser.newContext({
  proxy: { server: 'http://proxy:8080', username: 'user', password: 'pass' },
});
```

If you need both page navigation AND `context.request` through the proxy, set proxy at **both** levels or at context level only:

```javascript
const proxy = proxyConfig();  // returns null if no creds configured

browser = await chromium.launch({
  ...(proxy ? { proxy } : {}),   // page navigation proxy
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

context = await browser.newContext({
  ...(proxy ? { proxy } : {}),   // context.request proxy — must repeat
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
});
```

## BrightData Residential Proxy Config

```javascript
// Read from environment
const BD_HOST    = process.env.BRIGHTDATA_PROXY_HOST || 'brd.superproxy.io';
const BD_PORT    = process.env.BRIGHTDATA_PROXY_PORT || '22225';
const BD_USER    = process.env.BRIGHTDATA_PROXY_USER || '';   // brd-customer-XXX-zone-YYY
const BD_PASS    = process.env.BRIGHTDATA_PROXY_PASS || '';

// Sticky session — same residential IP for this process lifetime
// Append -session-<id> to the username
const BD_SESSION = `session-${Math.random().toString(36).slice(2, 10)}`;

function proxyConfig() {
  if (!BD_USER || !BD_PASS) return null;
  return {
    server:   `http://${BD_HOST}:${BD_PORT}`,
    username: `${BD_USER}-session-${BD_SESSION}`,
    password: BD_PASS,
  };
}
```

```bash
# .env
BRIGHTDATA_PROXY_HOST=brd.superproxy.io
BRIGHTDATA_PROXY_PORT=22225
BRIGHTDATA_PROXY_USER=brd-customer-hl_XXXXXX-zone-ZONE_NAME
BRIGHTDATA_PROXY_PASS=ZONE_PASSWORD
```

Test the credentials independently before wiring into Playwright:

```bash
# From inside Docker container or target machine
curl -x "http://${BRIGHTDATA_PROXY_USER}:${BRIGHTDATA_PROXY_PASS}@brd.superproxy.io:22225" \
     http://lumtest.com/myip.json
# Should return: {"ip":"...", "country":"US", "type":"residential"}
# 407 = wrong creds or suspended account
```

## Webdriver and Automation Masking

```javascript
// Apply via context.addInitScript() — runs before any page scripts
await context.addInitScript(() => {
  // Hide webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Fake plugin presence (zero plugins = headless signal)
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });

  // Normalize language
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Chrome runtime object (missing in non-Chrome headless)
  window.chrome = { runtime: {} };
});
```

```javascript
// Additional context options that reduce fingerprint signals
const ctxOpts = {
  userAgent:   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale:      'en-US',
  timezoneId:  'America/New_York',
  viewport:    { width: 1440, height: 900 },
  extraHTTPHeaders: {
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua':          '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':   '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
};
```

## page.evaluate Fetch Fallback

When `context.request` can't authenticate through the proxy (version bugs, edge cases), use `page.evaluate()` to run `fetch()` inside the actual browser tab. The browser handles proxy auth natively.

**Prerequisite:** The page must already be on the target domain so cookies are in scope for `credentials: 'include'`.

```javascript
async function browserFetch(page, url, headers = {}) {
  const result = await page.evaluate(async ({ url, headers }) => {
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',   // sends cookies automatically (same-origin)
    });
    const status = resp.status;
    const body   = await resp.text();
    return { status, body };
  }, { url, headers });

  if (result.status === 401 || result.status === 403) {
    throw new Error(`${url} → ${result.status} — session expired`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${url} → ${result.status}`);
  }
  return JSON.parse(result.body);
}
```

```javascript
// Usage: ensure page is on the target domain first
await page.goto('https://www.example.com/feed/', { waitUntil: 'domcontentloaded' });
const data = await browserFetch(page, 'https://www.example.com/api/internal/endpoint', {
  'accept': 'application/json',
  'x-csrf-token': csrfToken,
});
```

## LinkedIn Voyager API Pattern

LinkedIn's internal JSON API. Requires `li_at` cookie + `JSESSIONID` cookie for CSRF token derivation. All reads can use Voyager (no page navigation). Writes (connect, message, comment) still require DOM interaction.

```javascript
async function voyagerGet(context, path, params = {}) {
  const cookies   = await context.cookies('https://www.linkedin.com');
  const jsid      = (cookies.find(c => c.name === 'JSESSIONID')?.value || '').replace(/^"|"$/g, '');
  const csrfToken = jsid.startsWith('ajax:') ? jsid : (jsid ? `ajax:${jsid}` : 'ajax:0');

  const url = new URL(`https://www.linkedin.com/voyager/api${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const resp = await context.request.get(url.toString(), {
    headers: {
      'accept':                     'application/vnd.linkedin.normalized+json+2.1',
      'accept-language':            'en-US,en;q=0.9',
      'x-restli-protocol-version':  '2.0.0',
      'x-li-lang':                  'en_US',
      'csrf-token':                  csrfToken,
      'referer':                    'https://www.linkedin.com/feed/',
    },
  });

  if (resp.status() === 401 || resp.status() === 403) throw new Error(`Voyager ${path} → ${resp.status()} — re-inject li_at`);
  if (!resp.ok()) throw new Error(`Voyager ${path} → ${resp.status()}`);
  return resp.json();
}

// Key Voyager endpoints
// /identity/profiles/{vanity}?projection=(miniProfile,positionView)
// /notifications/byCategory?q=tabBadge&tabName=notifications
// /identity/dashboard/profileViewers?q=viewedByFollowingMember&timeRange=WEEK
// /identity/profiles/{vanity}/posts?q=memberShareFeed
// /relationships/connections?q=memberRelationship&connectionOf={memberUrn}
// /search/blended?q=blended&keywords=...&filters=List(resultType->CONTENT)
```

Voyager returns normalized JSON. Entities live in `data` or `included`. Use a helper to dereference URNs:

```javascript
function findIncluded(included, urn) {
  return included.find(e => e.entityUrn === urn || e['$id'] === urn) || null;
}
```

## Datacenter vs Residential Detection

LinkedIn and other platforms fingerprint at the IP level via Cloudflare. Signs of datacenter block:
- `HTTP 403` with `Set-Cookie: li_at=delete me` — session actively revoked
- `Clear-Site-Data: "storage"` response header — nuke all local storage
- `ERR_TOO_MANY_REDIRECTS` on authenticated pages — redirect loop after revocation

These are **IP-level signals**, not cookie or fingerprint signals. No amount of stealth patching fixes a datacenter IP. Only a residential proxy resolves it.

## Checklist

- [ ] Proxy set at `browser.newContext({ proxy })` — not just `chromium.launch()`
- [ ] Credentials tested with `curl -x` before wiring into Playwright
- [ ] Sticky session ID appended to username (`-session-XXXXXXXX`) — same IP per process
- [ ] `addInitScript` masks `navigator.webdriver`, plugins, languages, `window.chrome`
- [ ] `userAgent` set to current real Chrome on Windows (update periodically)
- [ ] `page.evaluate(fetch)` fallback ready if `context.request` returns 407
- [ ] Page is on target domain before using `credentials: 'include'` in evaluate fetch
- [ ] Session injection endpoint verifies via API call (no page navigation) — not `page.goto()`
- [ ] 403 + `Clear-Site-Data` header recognized as IP-level block — proxy swap, not code fix
