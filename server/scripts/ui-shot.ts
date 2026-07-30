/** Quick screenshot helper: captures the app's current home state. */
import { chromium } from "playwright-core";

const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
await page.goto("http://127.0.0.1:4560", { waitUntil: "networkidle" });
await page.screenshot({ path: "/tmp/blattbot-ui-shots/08-clean-home.png" });
await page.getByRole("button", { name: "Connect a project" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/blattbot-ui-shots/09-connect-form.png" });
await browser.close();
console.log("done");
