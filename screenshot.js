import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000); // Wait for mannequin to load
  await page.screenshot({ path: 'latest_screenshot.png' });
  await browser.close();
})();
