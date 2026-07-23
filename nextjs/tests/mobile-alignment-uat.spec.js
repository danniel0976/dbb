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
const TABLET_VIEWPORT = { width: 640, height: 900 }; // sm-breakpoint edge

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

// Vertical center of a bounding box.
function centerY(box) {
  return box.y + box.height / 2;
}

// Reads the scroll/overflow geometry of a rail element so a test can assert it
// is an *intentional* horizontal scroll container (overflowX auto/scroll) whose
// own box stays within the viewport, rather than a plain block whose children
// paint outside the viewport as uncontained overflow.
function railGeometry(locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      overflowX: cs.overflowX,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      left: rect.left,
      right: rect.right,
    };
  });
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

    // ── repair2 discriminators (these FAIL on 53c321a, where the rail was
    //    `flex-col` and stacked the four controls across separate levels) ──

    // (a) One-line rail: all four controls share a common vertical centerline.
    //     Stacked (flex-col) controls have centers tens/hundreds of px apart.
    const centers = [tabsBox, searchBox, filtersBox, sortBox].map(centerY);
    const centerSpread = Math.max(...centers) - Math.min(...centers);
    expect(centerSpread).toBeLessThanOrEqual(6);

    // (b) The rail is an intentional horizontal scroll container whose own box
    //     stays inside the viewport (no uncontained overflow), and it actually
    //     overflows here — the controls do not all fit at 390px, so the rail
    //     owns horizontal scrolling. On 53c321a overflowX was `visible` and the
    //     column did not overflow horizontally.
    const geo = await railGeometry(rail);
    expect(['auto', 'scroll']).toContain(geo.overflowX);
    expect(geo.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);
    expect(geo.scrollWidth).toBeGreaterThan(geo.clientWidth);

    // (c) First and last required controls are reachable via that scroll and
    //     stay focusable. Scroll the rail to each end and confirm the control
    //     is within the viewport, then focus it.
    await rail.evaluate((el) => el.scrollTo(0, 0));
    const firstTab = tabsInRail.getByRole('tab', { name: /^Singles/i });
    const firstBox = await firstTab.boundingBox();
    expect(firstBox.x).toBeGreaterThanOrEqual(-1);
    expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);

    await rail.evaluate((el) => el.scrollTo(el.scrollWidth, 0));
    const sortBoxEnd = await sortSelect.boundingBox();
    expect(sortBoxEnd.x).toBeGreaterThanOrEqual(-1);
    expect(sortBoxEnd.x + sortBoxEnd.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);
    await sortSelect.focus();
    await expect(sortSelect).toBeFocused();
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

    // ── repair2 discriminators (FAIL on 53c321a, where this row was
    //    `flex-wrap` and wrapped the controls onto a second line at 390px) ──
    const csRail = page.locator('[data-claim-sales-rail]');
    await expect(csRail).toBeVisible();

    // (a) One-line rail: tabs, Hot, Ending Soon, and search share a common
    //     vertical centerline. Wrapped controls sit a full row-height apart.
    const csCenters = [tabsBox, hotBox, endingBox, searchBox].map(centerY);
    const csSpread = Math.max(...csCenters) - Math.min(...csCenters);
    expect(csSpread).toBeLessThanOrEqual(6);

    // (b) Intentional horizontal scroll container, contained within viewport,
    //     actually overflowing at 390px (controls don't all fit).
    const csGeo = await railGeometry(csRail);
    expect(['auto', 'scroll']).toContain(csGeo.overflowX);
    expect(csGeo.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);
    expect(csGeo.scrollWidth).toBeGreaterThan(csGeo.clientWidth);

    // (c) First (section tabs) and last (search) controls reachable via scroll
    //     and focusable.
    await csRail.evaluate((el) => el.scrollTo(0, 0));
    const csFirstBox = await tablistLocator.boundingBox();
    expect(csFirstBox.x).toBeGreaterThanOrEqual(-1);
    expect(csFirstBox.x + csFirstBox.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);

    await csRail.evaluate((el) => el.scrollTo(el.scrollWidth, 0));
    const csSearchEnd = await csSearchInput.boundingBox();
    expect(csSearchEnd.x).toBeGreaterThanOrEqual(-1);
    expect(csSearchEnd.x + csSearchEnd.width).toBeLessThanOrEqual(PHONE_VIEWPORT.width + 1);
    await csSearchInput.focus();
    await expect(csSearchInput).toBeFocused();

    // Section switching still works from within the merged rail.
    await tablistLocator.getByRole('tab', { name: /^Singles/i }).click();
    await expect(tablistLocator.getByRole('tab', { name: /^Singles/i })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-bazaar-filter-rail]')).toBeVisible();
  });

  test('M4: Bazaar Singles rail — at 640px controls stay viewport-contained or reachable inside the rail\'s own horizontal scroll (no uncontained overflow)', async ({ page }) => {
    await page.setViewportSize(TABLET_VIEWPORT);
    await page.goto('/bazaar', { waitUntil: 'networkidle' });

    const rail = page.locator('[data-bazaar-filter-rail]');
    await expect(rail).toBeVisible({ timeout: 10000 });
    const sortSelect = rail.locator('select[aria-label="Sort listings"]');
    await expect(sortSelect).toBeVisible();

    // The rail is an intentional horizontal scroll container. On 53c321a the
    // rail was `sm:flex-row` with `overflow: visible`, so at exactly 640px the
    // Sort control painted ~95px past the right viewport edge as uncontained
    // overflow — overflowX `visible` fails this assertion.
    const geo = await railGeometry(rail);
    expect(['auto', 'scroll']).toContain(geo.overflowX);
    // The rail's own box never exceeds the viewport.
    expect(geo.right).toBeLessThanOrEqual(TABLET_VIEWPORT.width + 1);

    // Every control is contained; if the rail overflows, each control must be
    // reachable inside the rail's own scroll (never painted past the viewport
    // as uncontained overflow). Check the Sort control specifically — it was
    // the one that spilled on 53c321a.
    await rail.evaluate((el) => el.scrollTo(el.scrollWidth, 0));
    const sortBox = await sortSelect.boundingBox();
    expect(sortBox).not.toBeNull();
    expect(sortBox.x).toBeGreaterThanOrEqual(-1);
    expect(sortBox.x + sortBox.width).toBeLessThanOrEqual(TABLET_VIEWPORT.width + 1);
    await sortSelect.focus();
    await expect(sortSelect).toBeFocused();
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
