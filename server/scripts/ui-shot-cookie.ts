/** Screenshot the connect dialog with a pasted Overleaf editor link. */
import { chromium } from "playwright-core";

const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
await page.goto("http://127.0.0.1:4560", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Connect a project" }).click();
await page
  .getByPlaceholder(/overleaf\.com — or a project link/)
  .fill("https://overleaf.uni-paderborn.de/project/6a38f942205a91b533c318be");
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/blattbot-ui-shots/11-connect-autocookie.png" });
await browser.close();
console.log("done");
