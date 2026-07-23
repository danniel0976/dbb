// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Phase 44 Pass A — Showcase moved from Bazaar to a new Home page.
 * Headless render test covering:
 * - / (Home) renders the Hot Selling / Latest showcase rows, no console errors
 * - clicking a Home showcase card opens the detail inspector
 * - /bazaar renders the grid unconditionally, no console errors, and no
 *   showcase/hero markup left behind
 */

const TEST_EMAIL = 'checkout-buyer@dbb.test';
const TEST_PASSWORD = 'Phase44QaPass_2026!';

async function login(page) {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/library', { timeout: 10000 });
}

test.describe('Home showcase / Bazaar grid-only split', () => {
  test('Home renders showcase rows and opens the inspector on card click', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await login(page);

    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('Home');

    // Showcase section must be present with at least one row heading.
    await page.waitForSelector('[data-home-showcase]', { timeout: 10000 });
    const headings = page.locator('[data-home-showcase] h2');
    await expect(headings.first()).toBeVisible();

    // Click the first showcase card and confirm the inspector/detail opens.
    const firstCard = page.locator('[data-home-showcase] [role="button"]').first();
    await firstCard.waitFor({ state: 'visible', timeout: 10000 });
    await firstCard.click();

    const viewport = page.viewportSize();
    const isDesktop = viewport.width >= 1024;
    if (isDesktop) {
      await expect(page.locator('[data-testid="bazaar-detail-panel"]')).toBeVisible({ timeout: 5000 });
    } else {
      await expect(page.locator('[data-testid="bazaar-detail-sheet"]')).toBeVisible({ timeout: 5000 });
    }

    const closeButton = page.locator('button[aria-label="Close"]').first();
    await closeButton.click();
    await page.waitForTimeout(300);

    expect(consoleErrors.length).toBe(0);
  });

  test('/bazaar renders the grid only — no showcase/hero markup, no console errors', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await login(page);

    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toContainText('Bazaar');

    // Grid renders unconditionally.
    await page.waitForSelector('[data-bazaar-results]', { timeout: 10000 });
    const cards = page.locator('[data-bazaar-results] [role="button"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Showcase/hero markup must not exist anymore on Bazaar.
    await expect(page.locator('[data-bazaar-showcase]')).toHaveCount(0);
    await expect(page.locator('[data-home-showcase]')).toHaveCount(0);
    await expect(page.getByText('Hot Selling')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Latest' })).toHaveCount(0);

    expect(consoleErrors.length).toBe(0);
  });
});
