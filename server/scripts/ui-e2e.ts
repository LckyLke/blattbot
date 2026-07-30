/**
 * Browser-level test of the BlattBot UI: loads the app, selects the e2e project,
 * sends a real message, watches the turn stream, and screenshots every stage.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.UI_SHOTS_DIR ?? "/tmp/blattbot-ui-shots";
const EXECUTABLE = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 } });
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png` });

  await page.goto("http://127.0.0.1:4560", { waitUntil: "networkidle" });
  await shot("01-home");

  // Select the project created by the API e2e run.
  await page.getByRole("button", { name: /E2E Sample/ }).first().click();
  await page.waitForTimeout(1200);
  await shot("02-project-selected");

  const composer = page.getByPlaceholder(/Ask BlattBot/);
  await composer.fill(
    "Add a short Related Work section (two sentences) discussing attention mechanisms, " +
      "citing the 2017 paper 'Attention is All You Need' by Vaswani et al. (DOI 10.5555/3295222.3295349 " +
      "or find the right DOI yourself with search_papers). Verify it compiles.",
  );
  await composer.press("Enter");

  // Streaming state: the header shows the current activity while the turn runs.
  await page.waitForSelector("text=/thinking|writing|using tools/", { timeout: 30_000 });
  await page.waitForTimeout(9_000);
  await shot("03-streaming");

  // Wait for turn completion
  await page.waitForSelector("text=turn complete", { timeout: 420_000 });
  await page.waitForTimeout(2_500);
  await shot("04-turn-complete");

  // Proof tab auto-activates when a diff lands; make sure and screenshot.
  await page.getByRole("button", { name: "Proof", exact: false }).click();
  await page.waitForTimeout(600);
  await shot("05-proof");

  await page.getByRole("button", { name: "PDF", exact: true }).click();
  await page.waitForTimeout(1_500);
  await shot("06-pdf");

  await page.getByRole("button", { name: "References" }).click();
  await page.waitForTimeout(800);
  await shot("07-references");

  // Check key UI states are present.
  const proofBadge = await page.locator("text=turn complete").count();
  console.log("turn-complete markers:", proofBadge);
  const bodyText = await page.locator("body").innerText();
  const checks = {
    hasToolChip: /Compiling LaTeX|Adding citation|Editing/.test(bodyText),
    hasCost: /\$0\./.test(bodyText),
  };
  console.log("checks:", JSON.stringify(checks));

  await browser.close();
  console.log(`✅ UI E2E finished — screenshots in ${SHOTS}`);
}

main().catch((err) => {
  console.error("❌ UI E2E FAILED:", err);
  process.exit(1);
});
