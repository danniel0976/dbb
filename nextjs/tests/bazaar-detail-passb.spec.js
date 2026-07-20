// @ts-check
const { test, expect } = require('@playwright/test');

/**
 * Phase 44 Pass B — Detail Interaction
 * Headless render test for Bazaar card detail modal/inspector/sheet
 * 
 * Verifies:
 * - /bazaar loads without console errors
 * - Card detail opens (desktop inspector or mobile sheet)
 * - Card detail closes without errors
 * - No uncaught console errors during interaction
 */

test.describe('Bazaar Detail Interaction (Pass B)', () => {
  test('loads /bazaar, opens card detail, closes without console errors', async ({ page }) => {
    // Track console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Navigate to Bazaar
    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    
    // Verify page loaded
    await expect(page.locator('h1')).toContainText('Bazaar');
    
    // Wait for listings to load (look for card elements)
    await page.waitForSelector('[data-bazaar-mode]', { timeout: 10000 });
    
    // Find and click the first card to open detail
    const cards = page.locator('[data-bazaar-mode] .grid [role="button"], [data-bazaar-mode] .bazaar-showcase-shelf [role="button"]');
    const firstCard = cards.first();
    
    // Wait for at least one card to be clickable
    await firstCard.waitFor({ state: 'visible', timeout: 10000 });
    
    // Get viewport to determine desktop vs mobile behavior
    const viewport = page.viewportSize();
    const isDesktop = viewport.width >= 1024;
    
    // Click card to open detail
    await firstCard.click();
    
    // Wait for detail to appear
    if (isDesktop) {
      // Desktop: right-side inspector panel
      await expect(page.locator('aside[role="dialog"], .fixed.right-0[role="dialog"], div.fixed.right-0')).toBeVisible({ timeout: 5000 });
    } else {
      // Mobile: bottom sheet
      await expect(page.locator('[role="dialog"][aria-modal="true"].bottom-0, div[aria-label="Card details"]')).toBeVisible({ timeout: 5000 });
    }
    
    // Close the detail (click close button or backdrop)
    const closeButton = page.locator('button[aria-label="Close"]').first();
    await closeButton.click();
    
    // Wait for detail to close
    await page.waitForTimeout(500); // Allow transition to complete
    
    // Check for any console errors during the interaction
    expect(consoleErrors.length).toBe(0);
  });

  test('desktop inspector preserves scroll position', async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_MOBILE === 'true', 'Desktop-only test');
    
    // Set desktop viewport
    await page.setViewportSize({ width: 1280, height: 720 });
    
    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-bazaar-mode]', { timeout: 10000 });
    
    // Scroll down a bit
    const initialScrollY = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, 300));
    const scrolledY = await page.evaluate(() => window.scrollY);
    expect(scrolledY).toBeGreaterThan(0);
    
    // Open card detail
    const firstCard = page.locator('[data-bazaar-mode] .grid [role="button"]').first();
    await firstCard.click();
    await page.waitForSelector('.fixed.right-0[role="dialog"]', { timeout: 5000 });
    
    // Close detail
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    
    // Scroll position should be preserved
    const finalScrollY = await page.evaluate(() => window.scrollY);
    expect(Math.abs(finalScrollY - scrolledY)).toBeLessThan(50); // Allow small variance
  });

  test('mobile sheet drag-to-dismiss', async ({ page }) => {
    test.skip(process.env.PLAYWRIGHT_DESKTOP === 'true', 'Mobile-only test');
    
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    
    await page.goto('/bazaar', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-bazaar-mode]', { timeout: 10000 });
    
    // Open card detail
    const firstCard = page.locator('[data-bazaar-mode] [role="button"]').first();
    await firstCard.click();
    await page.waitForSelector('[aria-label="Card details"]', { timeout: 5000 });
    
    // Get sheet element
    const sheet = page.locator('[aria-label="Card details"]');
    const initialBox = await sheet.boundingBox();
    
    // Drag downward (dismiss gesture)
    await sheet.dispatchEvent('touchstart', {
      touches: [{ identifier: 1, target: await sheet.elementHandle(), clientX: 200, clientY: 500 }]
    });
    await sheet.dispatchEvent('touchmove', {
      touches: [{ identifier: 1, target: await sheet.elementHandle(), clientX: 200, clientY: 700 }]
    });
    await sheet.dispatchEvent('touchend', {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 700 }]
    });
    
    // Sheet should either snap back or dismiss (no crash)
    await page.waitForTimeout(500);
    
    // No errors should have occurred
    const bodyError = await page.locator('body').evaluate(el => el.innerText.includes('Error'));
    expect(bodyError).toBeFalsy();
  });
});
