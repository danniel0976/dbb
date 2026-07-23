// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

/**
 * Phase 44 Pass E — UAT feedback polish
 * Covers:
 *   1. Remove-from-library is a first-layer header action (no "More options"
 *      disclosure gate) but still requires an explicit confirm step.
 *   2. Successful save shows a visible in-panel "Saved" confirmation, not
 *      just the global toast.
 *   3. Bazaar's Singles/Claim Sales segmented control renders equal-width,
 *      non-overlapping tabs and in-place switching still works.
 *   4. .foil-card border spectrum is warm gold/amber (source check — not
 *      dependent on fixture data containing a foil card), and the Star
 *      control keeps its 44px hit target with a visually smaller glyph.
 *
 * Auth: checkout-seller@dbb.test (same local Supabase QA fixture used by
 * library-detail-passc.spec.js). The "Saved" test mutates that card's
 * quantity, same as the pre-existing passc quantity-save test already does —
 * not a new risk to the fixture.
 */

const TEST_EMAIL = 'checkout-seller@dbb.test';
const TEST_PASSWORD = 'PassC2QaTest_2026!';

async function login(page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/library', { timeout: 10000 });
  await page.waitForSelector('[aria-label^="View details for"]', { timeout: 10000 });
}

test.describe('Phase 44 Pass E — UAT polish', () => {
  test('foil-card border spectrum is warm gold/amber, not the old red/green/blue (source check)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');
    const match = css.match(/\.foil-card\s*{[^}]*}/);
    expect(match).not.toBeNull();
    const rule = match[0];
    expect(rule).toMatch(/#f39c12/i);
    expect(rule).toMatch(/#c9821c/i);
    expect(rule).not.toMatch(/#4a90e2/i); // old blue
    expect(rule).not.toMatch(/#27ae60/i); // old green
    expect(rule).not.toMatch(/#E02179/i); // old pink
  });

  test('desktop: Remove from library is a first-layer header action with an explicit confirm step', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    const firstCard = page.locator('[aria-label^="View details for"]').first();
    await firstCard.click();

    const panel = page.locator('[data-testid="library-detail-panel"]');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // No "More options" disclosure gating it anymore.
    await expect(panel.getByText('More options')).toHaveCount(0);

    const removeBtn = panel.locator('[data-testid="library-detail-panel-remove-btn"]');
    await expect(removeBtn).toBeVisible();

    const confirmBar = panel.locator('[data-testid="library-detail-panel-remove-confirm"]');
    await expect(confirmBar).toHaveCount(0);

    await removeBtn.click();
    await expect(confirmBar).toBeVisible({ timeout: 3000 });
    await expect(confirmBar).toContainText(/remove/i);

    // Cancel backs out without deleting the card.
    await confirmBar.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmBar).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Close/Remove don't collide as duplicate DOM ids across desktop panel
    // and mobile sheet trees, which both exist in the DOM simultaneously.
    await expect(page.locator('[data-testid="library-detail-panel-remove-btn"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="library-detail-sheet-remove-btn"]')).toHaveCount(1);
  });

  test('desktop: saving shows a visible in-panel "Saved" confirmation before closing', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    const firstCard = page.locator('[aria-label^="View details for"]').first();
    await firstCard.click();

    const panel = page.locator('[data-testid="library-detail-panel"]');
    await expect(panel).toBeVisible({ timeout: 5000 });

    const qtyInput = panel.locator('input[type="number"]').first();
    await qtyInput.fill('3');

    const saveBtn = panel.locator('[data-testid="library-detail-save-btn"]');
    await saveBtn.click();

    await expect(saveBtn).toContainText(/Saved/i, { timeout: 2000 });
    await expect(panel).toBeHidden({ timeout: 5000 });
  });

  test('bazaar: Singles/Claim Sales segmented control renders equal-width, non-overlapping tabs and switches in place', async ({ page }) => {
    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('Bazaar');

    const tablist = page.locator('[role="tablist"][aria-label="Bazaar section"]');
    await expect(tablist).toBeVisible({ timeout: 10000 });

    const singlesTab = tablist.getByRole('tab', { name: /Singles/i });
    const claimSalesTab = tablist.getByRole('tab', { name: /Claim Sales/i });

    const singlesBox = await singlesTab.boundingBox();
    const claimSalesBox = await claimSalesTab.boundingBox();
    expect(singlesBox).not.toBeNull();
    expect(claimSalesBox).not.toBeNull();

    // Equal width (within rounding slack) — this is what keeps the sliding
    // highlight pill's fixed 50% math aligned with the real button boundary.
    expect(Math.abs(singlesBox.width - claimSalesBox.width)).toBeLessThan(2);

    // No horizontal overlap/crop between the two tab labels.
    expect(singlesBox.x + singlesBox.width).toBeLessThanOrEqual(claimSalesBox.x + 1);

    // In-place switching still works both directions.
    await claimSalesTab.click();
    await expect(claimSalesTab).toHaveAttribute('aria-selected', 'true');
    await expect(singlesTab).toHaveAttribute('aria-selected', 'false');
    await expect(tablist).toBeVisible();

    await singlesTab.click();
    await expect(singlesTab).toHaveAttribute('aria-selected', 'true');
    await expect(claimSalesTab).toHaveAttribute('aria-selected', 'false');
  });

  test('library grid: Star control keeps a 44px hit target with a visually smaller glyph', async ({ page }) => {
    await login(page);

    const firstCard = page.locator('[aria-label^="View details for"]').first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });

    const star = firstCard.getByRole('button', { name: /^(Star|Unstar) /i });
    await expect(star).toBeVisible();

    const btnBox = await star.boundingBox();
    expect(btnBox.width).toBeGreaterThanOrEqual(43);
    expect(btnBox.height).toBeGreaterThanOrEqual(43);

    const glyphBox = await star.locator('span').boundingBox();
    expect(glyphBox).not.toBeNull();
    expect(glyphBox.width).toBeLessThan(btnBox.width * 0.8);
  });
});
