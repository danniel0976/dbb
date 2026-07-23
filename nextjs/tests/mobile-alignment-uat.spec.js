// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Phase 44 — mobile alignment/layering repair
 * (see Drops/phase44-mobile-alignment-uat-20260723.md, findings M1-M3)
 *
 * Covers:
 *   M1. Bazaar Singles: the Singles/Claim Sales segmented control shares one
 *       control rail with search/Filters/Sort at phone widths, instead of
 *       floating in a separate page-title block above it.
 *   M2. Bazaar Claim Sales: the same segmented control shares one control
 *       rail with Hot/Ending Soon/claim-sale search at phone widths, instead
 *       of the parent section selector remaining an unrelated second layer.
 *   M3. Library: the sticky search/sort/filter chrome never visually paints
 *       over the first card row while scrolling (opaque background, correct
 *       flow reservation below the mobile header).
 *   Regression guard: exactly one `[role="tablist"][aria-label="Bazaar
 *       section"]` exists in the DOM at any time/section/breakpoint — the
 *       fix renders the same control from a single call site rather than a
 *       hidden mobile/desktop duplicate, which would otherwise trip a
 *       Playwright strict-mode violation against the Pass E spec.
 *
 * Auth: checkout-seller@dbb.test (same local Supabase QA fixture used by
 * library-detail-passc.spec.js / library-bazaar-passe.spec.js) — only needed
 * for the Library checks; Bazaar and Claim Sales render without auth.
 */

const TEST_EMAIL = 'checkout-seller@dbb.test';
const TEST_PASSWORD = 'PassC2QaTest_2026!';
const PHONE_VIEWPORT = { width: 390, height: 844 }; // iPhone 12-class

// Waits on the search input rather than a rendered card: the sticky-chrome
// layering this file checks renders identically whether or not the fixture
// account's library currently has cards, and the local QA fixture's card
// count is outside this repair's scope (no fixture/data changes here).
async function login(page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/library', { timeout: 10000 });
  await page.waitForSelector('input[placeholder="Search by name..."]', { timeout: 10000 });
}

// No horizontal or vertical overlap between two bounding boxes.
function boxesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
}

test.describe('Phase 44 mobile alignment repair', () => {
  test('M1: Bazaar Singles — section tabs, search, Filters, and Sort form one control rail on phone widths', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('Bazaar');

    // Exactly one tablist in the DOM — no hidden mobile/desktop duplicate.
    const tablistLocator = page.locator('[role="tablist"][aria-label="Bazaar section"]');
    await expect(tablistLocator).toHaveCount(1);

    const rail = page.locator('[data-bazaar-filter-rail]');
    await expect(rail).toBeVisible({ timeout: 10000 });

    // The tabs must live inside the same rail as search/Filters/Sort, not a
    // separate block above it.
    const tabsInRail = rail.locator('[role="tablist"][aria-label="Bazaar section"]');
    await expect(tabsInRail).toHaveCount(1);

    const searchInput = rail.locator('input[placeholder="Search cards..."]');
    const filtersBtn = rail.getByRole('button', { name: /^Filters/ });
    const sortSelect = rail.locator('select[aria-label="Sort listings"]');
    await expect(searchInput).toBeVisible();
    await expect(filtersBtn).toBeVisible();
    await expect(sortSelect).toBeVisible();

    // No overlap/crop between any pair of controls in the rail.
    const tabsBox = await tabsInRail.boundingBox();
    const searchBox = await searchInput.boundingBox();
    const filtersBox = await filtersBtn.boundingBox();
    const sortBox = await sortSelect.boundingBox();
    for (const box of [tabsBox, searchBox, filtersBox, sortBox]) {
      expect(box).not.toBeNull();
    }
    expect(boxesOverlap(tabsBox, searchBox)).toBe(false);
    expect(boxesOverlap(searchBox, filtersBox)).toBe(false);
    expect(boxesOverlap(filtersBox, sortBox)).toBe(false);
    expect(boxesOverlap(tabsBox, filtersBox)).toBe(false);
    expect(boxesOverlap(tabsBox, sortBox)).toBe(false);

    // Keyboard focus remains usable across the merged rail.
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
  });

  test('M2: Bazaar Claim Sales — section tabs, Hot, Ending Soon, and search form one control rail on phone widths', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await page.goto('/bazaar', { waitUntil: 'networkidle' });

    const tablistLocator = page.locator('[role="tablist"][aria-label="Bazaar section"]');
    await tablistLocator.getByRole('tab', { name: /Claim Sales/i }).click();
    await expect(tablistLocator.getByRole('tab', { name: /Claim Sales/i })).toHaveAttribute('aria-selected', 'true');

    // Still exactly one tablist after switching sections — it moved into
    // ClaimSalesBrowse's own control row rather than being duplicated.
    await expect(tablistLocator).toHaveCount(1);

    const hotBtn = page.getByRole('button', { name: /^Hot$/ });
    const endingSoonBtn = page.getByRole('button', { name: /Ending Soon/ });
    const csSearchInput = page.locator('input[placeholder="Search claim sales..."]');
    await expect(hotBtn).toBeVisible();
    await expect(endingSoonBtn).toBeVisible();
    await expect(csSearchInput).toBeVisible();

    // The section tabs and Hot/Ending Soon/search now share one parent row
    // (not the old separate page-title block).
    const tabsBox = await tablistLocator.boundingBox();
    const hotBox = await hotBtn.boundingBox();
    const endingBox = await endingSoonBtn.boundingBox();
    const searchBox = await csSearchInput.boundingBox();
    for (const box of [tabsBox, hotBox, endingBox, searchBox]) {
      expect(box).not.toBeNull();
    }
    expect(boxesOverlap(tabsBox, hotBox)).toBe(false);
    expect(boxesOverlap(hotBox, endingBox)).toBe(false);
    expect(boxesOverlap(endingBox, searchBox)).toBe(false);
    expect(boxesOverlap(tabsBox, searchBox)).toBe(false);

    // Section switching still works from within the merged rail.
    await tablistLocator.getByRole('tab', { name: /^Singles/i }).click();
    await expect(tablistLocator.getByRole('tab', { name: /^Singles/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-bazaar-filter-rail]')).toBeVisible();
  });

  test('M1/M5 desktop: Bazaar section tabs remain a single, working control at desktop widths (no regression)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bazaar', { waitUntil: 'networkidle' });

    const tablistLocator = page.locator('[role="tablist"][aria-label="Bazaar section"]');
    await expect(tablistLocator).toHaveCount(1);
    await expect(tablistLocator).toBeVisible();

    await tablistLocator.getByRole('tab', { name: /Claim Sales/i }).click();
    await expect(tablistLocator).toHaveCount(1);
    await expect(tablistLocator.getByRole('tab', { name: /Claim Sales/i })).toHaveAttribute('aria-selected', 'true');

    await tablistLocator.getByRole('tab', { name: /^Singles/i }).click();
    await expect(tablistLocator).toHaveCount(1);
    await expect(tablistLocator.getByRole('tab', { name: /^Singles/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('M3: Library sticky control chrome sits below the mobile header, reserves flow height, and never paints over the first card row while scrolling', async ({ page }) => {
    await page.setViewportSize(PHONE_VIEWPORT);
    await login(page);

    const header = page.locator('header');
    const chrome = page.locator('input[placeholder="Search by name..."]').locator('xpath=ancestor::div[contains(@class, "dbb-glass-chrome")][1]');
    await expect(chrome).toBeVisible();

    // The fixture account's card count is outside this repair's scope; when
    // present, the first card row must never sit under the sticky chrome —
    // but the chrome/header layering checks below hold regardless of data.
    const firstCardLocator = page.locator('[aria-label^="View details for"]').first();
    const hasCards = await firstCardLocator.isVisible().catch(() => false);

    // Before scrolling: the chrome is still in normal flow further down the
    // page (below the binder rail / library summary row), so it must not
    // overlap the header, but it isn't pinned to it yet.
    const headerBoxBefore = await header.boundingBox();
    const chromeBoxBefore = await chrome.boundingBox();
    expect(headerBoxBefore).not.toBeNull();
    expect(chromeBoxBefore).not.toBeNull();
    expect(boxesOverlap(headerBoxBefore, chromeBoxBefore)).toBe(false);

    // The chrome must actually be a `position: sticky` box pinned exactly
    // 56px below the viewport top — matching DBBNav's real 56px mobile
    // header height — rather than a scroll-amount-dependent bounding-box
    // measurement (the fixture account's library may not have enough cards
    // to scroll far enough to visually re-engage the pin). This is also a
    // direct regression guard for the actual root cause behind the UAT M3
    // finding: `.dbb-glass-chrome`'s plain-CSS `position: relative` was
    // declared after `@tailwind utilities` in globals.css, so it silently
    // beat the `sticky` utility class on ties and this chrome (like
    // DBBNav's header/mobile tab bar) was never actually sticky/fixed at
    // all — see the `:where(.dbb-glass-chrome)` fix in globals.css.
    const chromePosition = await chrome.evaluate(el => getComputedStyle(el).position);
    const chromeTop = await chrome.evaluate(el => getComputedStyle(el).top);
    expect(chromePosition).toBe('sticky');
    expect(chromeTop).toBe('56px');

    // Scroll well past the chrome's natural (unstuck) position so it engages
    // `sticky`, then verify no visual overlap with the header or (when the
    // fixture has cards) the first card row.
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForTimeout(300); // let the sticky/backdrop-filter repaint settle

    const chromeBox = await chrome.boundingBox();
    const headerBox = await header.boundingBox();
    expect(chromeBox).not.toBeNull();
    expect(boxesOverlap(headerBox, chromeBox)).toBe(false);

    if (hasCards) {
      const firstCardBox = await firstCardLocator.boundingBox();
      expect(boxesOverlap(chromeBox, firstCardBox)).toBe(false);
    }

    // Opaque background: cards scrolling underneath must not be visible
    // through the rail (UAT M3 — translucent glass over scrolling cards
    // read as overlap).
    const bg = await chrome.evaluate(el => getComputedStyle(el).backgroundColor);
    const rgbaMatch = bg.match(/rgba?\(([^)]+)\)/);
    expect(rgbaMatch).not.toBeNull();
    const parts = rgbaMatch[1].split(',').map(s => parseFloat(s.trim()));
    const alpha = parts.length === 4 ? parts[3] : 1;
    expect(alpha).toBeGreaterThanOrEqual(0.99);

    // Explicit, ordered z-index ownership: header above the search chrome.
    const headerZ = await header.evaluate(el => Number(getComputedStyle(el).zIndex));
    const chromeZ = await chrome.evaluate(el => Number(getComputedStyle(el).zIndex));
    expect(headerZ).toBeGreaterThan(chromeZ);

    // Keyboard focus remains usable after scrolling.
    const searchInput = page.locator('input[placeholder="Search by name..."]');
    await searchInput.focus();
    await expect(searchInput).toBeFocused();
  });
});
