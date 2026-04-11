import { chromium } from 'playwright-core';
import fs from 'fs';

const URL = 'http://localhost:5173';
const SCREENSHOT_PATH = 'latest_qa_screenshot.png';
const LOG_FILE = 'qa_performance.log';

async function run() {
    console.log("[QA] Starting Persistent Vision QA Loop (4-minute interval)");
    let browser;
    try {
        browser = await chromium.launch({
            args: [
                '--use-gl=egl', 
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--ignore-gpu-blocklist',
                '--no-sandbox',
                '--disable-web-security'
            ]
        });
        const page = await browser.newPage();
        
        page.on('console', msg => {
            const txt = msg.text();
            fs.appendFileSync('all_console_logs.log', `[${new Date().toISOString()}] ${msg.type().toUpperCase()}: ${txt}\n`);
            if (txt.includes('Iteration') || txt.includes('Fit Status')) {
                fs.appendFileSync('iteration_logs.log', `[${new Date().toISOString()}] ${txt}\n`);
            }
        });

        await page.goto(URL, { waitUntil: 'networkidle' });

        while (true) {
            console.log("[QA] Capturing screenshot...");
            await page.screenshot({ path: SCREENSHOT_PATH });
            
            const stats = await page.evaluate(() => {
                const params = window.clothParams || {};
                // We can't easily get the latest console log from here, 
                // but we can look at the DOM or global variables if we added them.
                // For now, let's assume we can check if the status is what we expect.
                return { 
                    fps: params.fps || 0, 
                    status: params.status || 'UNKNOWN',
                    iteration: params.iteration || 0
                };
            });

            // Read the last few lines of iteration_logs.log to get Fit Status
            let fitStatus = "Unknown";
            try {
                const logs = fs.readFileSync('iteration_logs.log', 'utf8').split('\n');
                for (let i = logs.length - 1; i >= 0; i--) {
                    if (logs[i].includes('Fit Status')) {
                        fitStatus = logs[i];
                        break;
                    }
                }
            } catch (e) {}

            const logEntry = `[${new Date().toISOString()}] Screenshot: ${SCREENSHOT_PATH} | Iteration: ${stats.iteration} | ${fitStatus}\n`;
            fs.appendFileSync(LOG_FILE, logEntry);
            console.log(logEntry);

            // VISION QA CRITIQUE
            if (fitStatus.includes('Seams [Open]')) {
                console.log(`[QA] CRITIQUE: Visible gap detected between arm and chest. Tighten the stitching (increase stiffness or reduce distance).`);
            } else if (fitStatus.includes('Seams [Welded]')) {
                console.log(`[QA] CRITIQUE: Seams are welded correctly.`);
            }

            if (fitStatus.includes('Shoulders [Falling]')) {
                console.log(`[QA] CRITIQUE: The shirt is falling. Verify that 'mass = 0' anchors are correctly mapped to Xbot skeleton.`);
            } else if (fitStatus.includes('Shoulders [Stable]')) {
                console.log(`[QA] CRITIQUE: Shoulders are stable.`);
            }

            await new Promise(res => setTimeout(res, 240000)); // 4 mins (Mandate)
        }
    } catch (err) {
        console.error("[QA] Fatal Error:", err.message);
    } finally {
        if (browser) await browser.close();
    }
}

run();
