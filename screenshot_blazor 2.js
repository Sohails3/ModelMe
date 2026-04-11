import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  try {
    console.log("Navigating to http://localhost:5001...");
    await page.goto('http://localhost:5001', { waitUntil: 'networkidle' });
    console.log("Waiting for 5 seconds for simulation to settle...");
    await page.waitForTimeout(5000); 
    await page.screenshot({ path: 'blazor_screenshot.png' });
    console.log("Screenshot saved as blazor_screenshot.png");
  } catch (e) {
    console.error("Error taking screenshot:", e);
  } finally {
    await browser.close();
  }
})();
