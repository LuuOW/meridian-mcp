import { test, expect } from '@playwright/test'

/* Content sanity — every page should reflect current reality, not stale
   tech / abandoned features. These tests catch regressions where copy
   says "on-device" but inference moved server-side, etc. */

test('lens reflects server-side VLM (not on-device)', async ({ page }) => {
  await page.goto('https://meridian.ask-meridian.uk/lens/', { waitUntil: 'domcontentloaded' })
  const body = await page.locator('body').innerText()
  expect(body).toContain('GPT-4o-mini')
  expect(body).toContain('Server-side')
  // these claims should NOT be on the page anymore
  expect(body).not.toContain('SMOLVLM-256M')
  expect(body).not.toContain('vision-language model running on-device')
  expect(body).not.toContain('one-time download')
  // sw.js registration was removed → page must not even attempt it
  const sw = await page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL || '')
  expect(sw).not.toMatch(/lens.*sw\.js/i)
})

test('miniapp footer describes real routing (not Workers AI + Python)', async ({ page }) => {
  await page.goto('https://ask-meridian.uk/miniapp/', { waitUntil: 'domcontentloaded' })
  const footer = await page.locator('footer.mini-foot').innerText()
  expect(footer).toContain('Llama-3.3-70B')
  expect(footer).toContain('GitHub Models')
  expect(footer).not.toContain('Llama-3.1-8b')
  expect(footer).not.toContain('Workers AI')
  expect(footer).not.toContain('Python-based physics scoring')
})

test('docs self-host section: no v0.3.2 install instructions surfaced as current', async ({ page }) => {
  await page.goto('https://ask-meridian.uk/docs/', { waitUntil: 'domcontentloaded' })
  const body = await page.locator('body').innerText()
  // v0.3.2 may be mentioned as legacy, but never as the recommended install
  const v32CodeBlocks = await page.locator('pre code:has-text("meridian-mcp@0.3.2")').count()
  expect(v32CodeBlocks).toBe(0)
  // current bundled-corpus claim about miniapp must be gone
  expect(body).not.toContain('routes against the bundled 88-candidate corpus')
})

test('docs allowlist mentions canonical meridian.ask-meridian.uk', async ({ page }) => {
  await page.goto('https://ask-meridian.uk/docs/', { waitUntil: 'domcontentloaded' })
  const allowlistItems = await page.locator('li code').allTextContents()
  expect(allowlistItems.some(t => t.includes('meridian.ask-meridian.uk'))).toBe(true)
})

test('photon page uses canonical app links (no stale legacy lens.ask-meridian.uk in nav)', async ({ page }) => {
  await page.goto('https://photon.ask-meridian.uk/', { waitUntil: 'domcontentloaded' })
  // The Apps dropdown / mobile-menu Apps list links to canonical lens URL
  const links = await page.locator('a[href*="ask-meridian.uk/lens/"]').count()
  expect(links).toBeGreaterThan(0)
  const stale = await page.locator('a[href="https://lens.ask-meridian.uk"]').count()
  expect(stale).toBe(0)
})
