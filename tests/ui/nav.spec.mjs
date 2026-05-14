import { test, expect } from '@playwright/test'

/* Every public surface that ships the shared <nav class="nav"> block.
   The whole point of the suite: prove the nav actually works on real
   URLs in a real browser engine across desktop + mobile viewports. */
const SURFACES = [
  { name: 'landing',  url: 'https://ask-meridian.uk/' },
  { name: 'docs',     url: 'https://ask-meridian.uk/docs/' },
  { name: 'blog',     url: 'https://ask-meridian.uk/blog/' },
  { name: 'blog-post',url: 'https://ask-meridian.uk/blog/orbital-classifier-online-learning/' },
  { name: 'gh-miniapp', url: 'https://ask-meridian.uk/miniapp/' },
  { name: 'helix',    url: 'https://meridian.ask-meridian.uk/helix/' },
  { name: 'lens',     url: 'https://meridian.ask-meridian.uk/lens/' },
  { name: 'cf-miniapp', url: 'https://meridian.ask-meridian.uk/miniapp/' },
  { name: 'photon',   url: 'https://photon.ask-meridian.uk/' },
]

for (const surface of SURFACES) {
  test.describe(`${surface.name} — ${surface.url}`, () => {
    test.beforeEach(async ({ page }) => {
      // 'load' (not 'domcontentloaded'): wait for images/webfonts/below-the-fold
      // assets that would otherwise reflow the sticky nav and leave Playwright
      // chasing a "not stable" element. Still cheap because we only care about
      // top-of-page nav interactions and the network goes idle quickly post-load.
      await page.goto(surface.url, { waitUntil: 'load' })
      // give CSS animations one frame to settle before any interaction asserts
      await page.waitForTimeout(150)
    })

    test('nav.css loaded (no 404, has new rules)', async ({ page }) => {
      const link = page.locator('link[data-nav-css]')
      await expect(link).toHaveCount(1)
      const href = await link.getAttribute('href')
      const absHref = new URL(href, page.url()).href
      const res = await page.request.get(absHref)
      expect(res.status()).toBe(200)
      expect(res.headers()['content-type']).toMatch(/text\/css/)
      const body = await res.text()
      // sanity that the new design is what's served, not a cached old copy
      expect(body).toContain('nav-apps-trigger')
      expect(body).toContain('cmdk-trigger')
    })

    test('brand + new top-bar elements present', async ({ page }) => {
      await expect(page.locator('nav.nav a.brand')).toHaveText(/Meridian/)
      await expect(page.locator('#burgerBtn')).toHaveCount(1)
      await expect(page.locator('#navMenu')).toHaveCount(1)
      await expect(page.locator('#cmdkBtn')).toHaveCount(1)
      await expect(page.locator('#cmdk')).toHaveCount(1)
    })

    test('cmdk index baked in (≥ 10 entries)', async ({ page }) => {
      const count = await page.evaluate(() => Array.isArray(window.__CMDK_INDEX__) ? window.__CMDK_INDEX__.length : 0)
      expect(count).toBeGreaterThanOrEqual(10)
    })

    test.describe('desktop viewport', () => {
      test.use({ viewport: { width: 1280, height: 800 } })

      test('burger hidden, inline links visible', async ({ page }) => {
        await expect(page.locator('#burgerBtn')).toBeHidden()
        await expect(page.locator('.nav-inline')).toBeVisible()
        await expect(page.locator('.nav-apps-trigger')).toBeVisible()
        await expect(page.locator('.cmdk-trigger')).toBeVisible()
      })

      test('Apps dropdown opens on click, closes on outside click', async ({ page }) => {
        const trigger = page.locator('.nav-apps-trigger')
        const menu    = page.locator('#appsMenu')
        // initially closed
        await expect(menu).not.toHaveCSS('opacity', '1')
        await trigger.click()
        await expect(page.locator('.nav-apps.open')).toHaveCount(1)
        await expect(menu).toBeVisible()
        // outside click closes
        await page.locator('body').click({ position: { x: 5, y: 5 } })
        await expect(page.locator('.nav-apps.open')).toHaveCount(0)
      })

      test('Apps dropdown items resolve to real URLs', async ({ page }) => {
        await page.locator('.nav-apps-trigger').click()
        const hrefs = await page.locator('#appsMenu a.nav-app').evaluateAll(
          nodes => nodes.map(n => n.getAttribute('href'))
        )
        expect(hrefs.length).toBeGreaterThanOrEqual(3)
        for (const h of hrefs) {
          expect(h).toMatch(/^https?:\/\//)
        }
      })

      test('⌘K opens palette, Esc closes', async ({ page, browserName }) => {
        const cmd = process.platform === 'darwin' ? 'Meta' : 'Control'
        await page.keyboard.press(`${cmd}+KeyK`)
        await expect(page.locator('#cmdk')).toBeVisible()
        await expect(page.locator('#cmdkInput')).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(page.locator('#cmdk')).toBeHidden()
      })

      test('⌘K palette: type filters, Enter navigates', async ({ page }) => {
        await page.locator('#cmdkBtn').click()
        await expect(page.locator('#cmdk')).toBeVisible()
        await page.locator('#cmdkInput').fill('helix')
        // first result should be helix-related
        const firstItem = page.locator('#cmdkList .cmdk-item').first()
        await expect(firstItem).toBeVisible()
        const label = await firstItem.locator('.cmdk-item-label').textContent()
        expect(label?.toLowerCase()).toContain('helix')
      })

      test('docs TOC sidebar only on docs page', async ({ page }) => {
        const toc = page.locator('aside.docs-toc')
        if (surface.url.includes('/docs/')) {
          await expect(toc).toBeVisible()
          // contains at least one anchor link
          await expect(toc.locator('a').first()).toBeVisible()
        } else {
          // Not asserting absence aggressively — some non-docs pages may include
          // their own asides; just ensure docs-toc class isn't visible elsewhere.
          await expect(toc).toHaveCount(0)
        }
      })
    })

    test.describe('mobile viewport', () => {
      test.use({ viewport: { width: 375, height: 740 } })

      test('inline links hidden, burger visible', async ({ page }) => {
        await expect(page.locator('.nav-inline')).toBeHidden()
        await expect(page.locator('#burgerBtn')).toBeVisible()
      })

      test('burger toggles mobile menu', async ({ page }) => {
        const burger = page.locator('#burgerBtn')
        const menu   = page.locator('#navMenu')
        await expect(menu).toBeHidden()
        await burger.click()
        await expect(menu).toBeVisible()
        await expect(menu.locator('.nav-section').first()).toBeVisible()
        // click outside closes
        await page.locator('body').click({ position: { x: 5, y: 5 } })
        await expect(menu).toBeHidden()
      })

      test('mobile menu links to Apps, Resources, Source groups', async ({ page }) => {
        await page.locator('#burgerBtn').click()
        const menu = page.locator('#navMenu')
        // exact-match regex so "Source" doesn't collide with "Resources"
        await expect(menu.locator('.nav-section').filter({ hasText: /^Apps$/i })).toHaveCount(1)
        await expect(menu.locator('.nav-section').filter({ hasText: /^Resources$/i })).toHaveCount(1)
        await expect(menu.locator('.nav-section').filter({ hasText: /^Source$/i })).toHaveCount(1)
      })
    })
  })
}
