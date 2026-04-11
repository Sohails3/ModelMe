import { chromium } from 'playwright-core';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  try {
    console.log("Navigating to http://localhost:5001 and capturing logs...");
    await page.goto('http://localhost:5001', { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000); 
  } catch (e) {
    console.error("Error navigating:", e);
  } finally {
    await browser.close();
  }
})();
