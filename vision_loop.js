import { chromium } from 'playwright-core';
import fs from 'fs';

const URL = 'http://localhost:5173';
const SCREENSHOT_DIR = 'vision_screenshots';
const LOG_FILE = 'vision_loop.log';
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const RUN_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

async function ensureDir(path) {
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path, { recursive: true });
    }
}

async function waitForAppReady(page) {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
        return window.clothParams && window.clothParams.status && window.clothParams.status !== 'INITIALIZING';
    }, { timeout: 120000 });
}

async function captureAndAdjust(page) {
    await ensureDir(SCREENSHOT_DIR);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = `${SCREENSHOT_DIR}/vision_${timestamp}.png`;

    await page.screenshot({ path: screenshotPath });

    const status = await page.evaluate(() => {
        if (typeof window.getClothStatus === 'function') {
            return window.getClothStatus();
        }
        const params = (window as any).clothParams || {};
        return {
            drapeStatus: params.status || 'Unknown',
            seamStatus: 'Unknown',
            shoulderStatus: 'Unknown',
            avgY: null,
            initialAvgY: null,
            maxStitchDist: null,
            clippingRatio: null,
            penetrationCount: null,
            fps: params.fps || 0,
            iteration: params.iteration || 0,
            params
        };
    });

    let didAdjust = false;

    await page.evaluate(() => {
        const clothParams = (window as any).clothParams;
        const diagnostics = (window as any).clothDiagnostics || {};
        if (!clothParams) return;

        const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

        const drapeStatus = diagnostics.drapeStatus || 'Unknown';
        const seamStatus = diagnostics.seamStatus || 'Unknown';

        // If fabric is still bunched, decrease stiffness by 0.1 (with lower bound)
        if (drapeStatus === 'Still Bunched') {
            clothParams.stiffness = clamp((clothParams.stiffness || 0.95) - 0.1, 0.2, 1.2);
            clothParams.stiffnessMultiplier = clamp((clothParams.stiffnessMultiplier || 1.0) - 0.1, 0.2, 1.2);
        }

        // If side seams are open, tighten StitchConstraints via multiplier
        if (seamStatus === 'Open') {
            clothParams.stitchStiffnessMultiplier = clamp((clothParams.stitchStiffnessMultiplier || 1.0) + 0.1, 0.5, 2.0);
        }
    });

    const updated = await page.evaluate(() => {
        const diagnostics = (window as any).clothDiagnostics || {};
        const params = (window as any).clothParams || {};
        return {
            drapeStatus: diagnostics.drapeStatus || 'Unknown',
            seamStatus: diagnostics.seamStatus || 'Unknown',
            shoulderStatus: diagnostics.shoulderStatus || 'Unknown',
            fps: params.fps || 0,
            iteration: params.iteration || 0,
            stiffness: params.stiffness,
            stiffnessMultiplier: params.stiffnessMultiplier,
            stitchStiffnessMultiplier: params.stitchStiffnessMultiplier
        };
    });

    const logLine = `[${new Date().toISOString()}] Screenshot: ${screenshotPath} | Iteration: ${updated.iteration} | Drape Status: [${updated.drapeStatus}]. FPS: [${updated.fps}]. Seams: [${updated.seamStatus}]. Shoulders: [${updated.shoulderStatus}]. ` +
        `Stiffness: ${updated.stiffness}, Multiplier: ${updated.stiffnessMultiplier}, StitchMultiplier: ${updated.stitchStiffnessMultiplier}\n`;

    fs.appendFileSync(LOG_FILE, logLine);
    console.log(logLine.trimEnd());
}

async function runVisionLoop() {
    console.log("[VISION] Starting 8-hour vision loop (5-minute interval)");
    let browser;
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < RUN_DURATION_MS) {
            try {
                if (!browser) {
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
                }

                const page = await browser.newPage();

                page.on('console', msg => {
                    const txt = msg.text();
                    fs.appendFileSync('vision_console.log', `[${new Date().toISOString()}] ${msg.type().toUpperCase()}: ${txt}\n`);
                });

                await waitForAppReady(page);
                await captureAndAdjust(page);
                await page.close();
            } catch (cycleErr) {
                console.error("[VISION] Cycle error:", cycleErr.message);
                fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Cycle error: ${cycleErr.message}\n`);
                if (browser) {
                    await browser.close();
                    browser = undefined;
                }
            }

            const remaining = RUN_DURATION_MS - (Date.now() - startTime);
            if (remaining <= 0) break;
            await new Promise(res => setTimeout(res, Math.min(INTERVAL_MS, remaining)));
        }
    } catch (err) {
        console.error("[VISION] Fatal error:", err.message);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Fatal error: ${err.message}\n`);
    } finally {
        if (browser) await browser.close();
        console.log("[VISION] Vision loop finished.");
    }
}

runVisionLoop();

