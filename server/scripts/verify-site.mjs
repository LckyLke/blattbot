/** Verify the static marketing site in a real browser. Serve docs/ locally first. */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const base = process.env.SITE_URL ?? "http://127.0.0.1:4640";
const shots = process.env.SITE_SHOTS_DIR ?? "/tmp/blattbot-site-demo/site-qa";
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BLATTBOT_BROWSER_EXECUTABLE ?? "/usr/bin/chromium", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().startsWith(base) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(base, { waitUntil: "networkidle" });
  const video = page.locator("#walkthrough");
  await video.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("video").readyState >= 1);
  assert(await video.evaluate(el => el.paused && !el.autoplay && el.controls), "Explicit playback with native controls");
  await page.screenshot({ path: join(shots, "desktop-demos.png") });
  for (const clip of ["graph", "writing", "evidence"]) {
    await page.locator(`#demo-${clip}`).click();
    await page.waitForFunction(key => { const el = document.querySelector("video"); return el.currentSrc.includes(`/${key}.mp4`) && el.readyState >= 2 && el.currentTime > 0.2; }, clip);
    assert(await video.evaluate(el => el.duration > 15 && el.duration < 60), "A short playable video");
    assert.equal(await page.locator(`#demo-${clip}`).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator('#demo-panel').getAttribute('aria-labelledby'), `demo-${clip}`);
    await page.locator("#demo-play").click();
    assert(await video.evaluate(el => el.paused));
    // Captions load and parse, rather than merely returning HTTP 200.
    await video.evaluate(el => { el.textTracks[0].mode = "hidden"; });
    await page.waitForFunction(() => document.querySelector("video").textTracks[0]?.cues?.length >= 4);
  }
  await page.locator("#demo-evidence").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator("#demo-graph").getAttribute("aria-selected"), "true");
  assert(await video.evaluate(el => el.paused), "Keyboard browsing does not start motion");
  await page.keyboard.press("End");
  assert.equal(await page.locator("#demo-writing").getAttribute("aria-selected"), "true");
  await page.keyboard.press("Home");
  assert.equal(await page.locator("#demo-evidence").getAttribute("aria-selected"), "true");
  await page.locator("#demo-play").click();
  await page.locator("footer").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("video").paused);
  const imageButtons = page.locator(".figure-zoom");
  for (const button of await imageButtons.all()) {
    await button.scrollIntoViewIfNeeded();
    await button.locator("img").evaluate(el => el.decode());
  }
  await imageButtons.first().click();
  await page.locator(".lightbox").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".lightbox").waitFor({ state: "detached" });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(shots, "desktop-page.png"), fullPage: true });
  for (const width of [390, 320, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No overflow at ${width}px`);
    assert(await page.locator(".brand-mark").evaluate(el => el.getBoundingClientRect().height < 40), "The wordmark stays on one line");
    assert(await page.locator(".site-nav a").evaluateAll(links => links.every(el => el.getBoundingClientRect().height < 30)), "Navigation labels stay on one line");
    await page.screenshot({ path: join(shots, `mobile-${width}-top.png`) });
    await page.screenshot({ path: join(shots, `mobile-${width}.png`), fullPage: true });
    await video.scrollIntoViewIfNeeded();
    await page.locator("#demo-writing").click();
    await page.waitForFunction(() => document.querySelector("video").currentSrc.includes("writing.mp4") && !document.querySelector("video").paused);
    await page.locator("#demo-play").click();
  }
  assert.deepEqual(errors, []);
  await context.close();
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const fallback = await noJs.newPage();
  await fallback.goto(base);
  assert.equal(await fallback.locator("noscript a").count(), 3);
  await noJs.close();
  console.log(`Website passed: playable clips, captions, keyboard controls, offscreen pause, image loading, lightbox, responsive layout and no-JS links. Screenshots: ${shots}`);
} finally { await browser.close(); }
