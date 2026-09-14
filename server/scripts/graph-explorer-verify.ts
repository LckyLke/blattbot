import type { Page } from "playwright-core";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Exercise the real renderer at the saved-graph limit, without provider/model calls. */
export async function verifyGraphExplorer(
  original: Page,
  base: string,
  projectId: string,
  shots: string,
) {
  const page = await original.context().newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 });
  const nodes = Array.from({ length: 5000 }, (_, i) => ({
    id: `W${i + 1}`,
    keys: i < 72 ? [`source${i + 1}`] : [],
    title:
      i === 1841
        ? "Learning relational structure with graph networks"
        : `${["Graph representation learning", "Neural message passing", "Knowledge base completion", "Scientific discovery", "Structured prediction"][i % 5]} — study ${i + 1}`,
    year: 1990 + (i % 36),
    authors: i === 1841 ? ["Émilie Müller"] : ["Ada Smith"],
    doi: `10.1234/paper${i + 1}`,
    ref: `10.1234/paper${i + 1}`,
    inProject: i < 72,
    resolved: true,
    referencesLoaded: i < 72,
    venue: "Research Methods",
    citationCount: i % 800,
  }));
  const edges = nodes.flatMap((n, i) =>
    Array.from({ length: 4 }, (_, j) => ({
      from: n.id,
      to: `W${((i + 1 + j * 53) % nodes.length) + 1}`,
      source: "OpenAlex",
      at: "2026-09-14T09:00:00.000Z",
    })),
  );
  const graph = {
    nodes,
    edges,
    at: "2026-09-14T09:00:00.000Z",
    errors: {},
    pendingKeys: [],
    truncated: false,
    note: "Synthetic test graph. A cites B; coverage is incomplete.",
    indexing: { state: "ready", completed: 72, total: 72, pending: 0 },
  };
  let detailCalls = 0;
  await page.route(`**/api/projects/${projectId}/research/graph`, (route) =>
    route.fulfill({ json: graph }),
  );
  await page.route(
    `**/api/projects/${projectId}/research/graph/details`,
    (route) => {
      detailCalls++;
      const { node } = route.request().postDataJSON();
      const found = nodes.find((n) => n.id === node);
      return route.fulfill({
        json: {
          ...found,
          detailsLoaded: true,
          manuscriptCitations: found?.inProject
            ? [
                {
                  key: found.keys[0],
                  file: "main.tex",
                  line: 2,
                  column: 1,
                  kind: "citation",
                  excerpt: "Fixture passage citing this work.",
                },
              ]
            : [],
          abstract:
            "We study relational structure using message passing. The evaluation covers three benchmark datasets; generalization beyond these datasets remains untested.",
          retrievedAt: graph.at,
        },
      });
    },
  );
  try {
    const start = Date.now();
    await page.goto(base);
    const explorer = page.getByRole("dialog", {
      name: "Citation graph explorer",
    });
    const openProject = page.getByRole("button", {
      name: "Open Research Fixture",
    });
    await explorer.or(openProject).first().waitFor();
    if (await openProject.isVisible()) await openProject.click();
    await explorer
      .getByRole("button", { name: "Open graph full screen" })
      .click();
    await page.waitForFunction(
      () => !!document.querySelector("dialog:modal .cg-webgl canvas"),
    );
    await page.waitForFunction(
      () => !document.querySelector(".cg-layout-status"),
    );
    const loadMs = Date.now() - start;
    if (await explorer.locator(".cg-fallback").count())
      throw new Error("WebGL renderer fell back unexpectedly");
    const bounds = await explorer.boundingBox();
    if (!bounds || bounds.width < 1595 || bounds.height < 995)
      throw new Error("Graph did not fill the viewport");
    if (await explorer.evaluate((el) => el.scrollWidth > el.clientWidth + 2))
      throw new Error("Fullscreen graph overflows horizontally");
    await page.screenshot({
      path: join(shots, "12-graph-fullscreen-5000.png"),
    });
    const search = explorer.getByLabel("Find a paper");
    await page.keyboard.press("Control+f");
    if (!(await search.evaluate((el) => el === document.activeElement)))
      throw new Error("Ctrl-F did not focus graph search");
    const searchStart = Date.now();
    await search.fill("emilie muller");
    await explorer
      .getByRole("button", {
        name: "External source: Learning relational structure with graph networks",
        exact: true,
      })
      .waitFor();
    const searchMs = Date.now() - searchStart;
    await search.press("Enter");
    await explorer
      .getByRole("heading", {
        name: "Learning relational structure with graph networks",
        exact: true,
      })
      .waitFor();
    await explorer.getByText(/We study relational structure/).waitFor();
    if (detailCalls !== 1)
      throw new Error(`Expected one selected-paper lookup, got ${detailCalls}`);
    await explorer
      .getByRole("tab", { name: "Connections", exact: true })
      .click();
    await explorer.getByLabel("Neighborhood depth").selectOption("1");
    await explorer.getByLabel("Connection direction").selectOption("incoming");
    await explorer.getByRole("button", { name: "Fit graph" }).click();
    await page.screenshot({ path: join(shots, "13-graph-paper-details.png") });
    const divider = explorer.getByRole("separator", {
      name: "Resize paper panel",
    });
    const panel = explorer.getByRole("complementary", {
      name: "Paper details",
    });
    await explorer.getByRole("button", { name: "Center paper", exact: true }).click();
    await page.waitForTimeout(300);
    const widthBefore = (await panel.boundingBox())!.width;
    await divider.focus();
    await divider.press("ArrowLeft");
    if ((await panel.boundingBox())!.width < widthBefore + 20)
      throw new Error("Keyboard panel resize failed");
    const separatorBounds = (await divider.boundingBox())!;
    await page.mouse.move(
      separatorBounds.x + separatorBounds.width / 2,
      separatorBounds.y + 90,
    );
    await page.mouse.down();
    await page.mouse.move(separatorBounds.x - 60, separatorBounds.y + 90, {
      steps: 8,
    });
    await page.mouse.up();
    if ((await panel.boundingBox())!.width < widthBefore + 75)
      throw new Error("Pointer panel resize failed");
    const resizedStage = (await explorer.locator(".cg-stage").boundingBox())!;
    await page.mouse.move(resizedStage.x + resizedStage.width / 2, resizedStage.y + resizedStage.height / 2);
    await page.waitForFunction(() => document.querySelector(".cg-tooltip strong")?.textContent === "Learning relational structure with graph networks");
    // Keyboard-accessible result lists and filters still work for nodes beyond the old cap.
    await explorer.getByRole("button", { name: "Close paper details" }).click();
    await search.fill("10.1234/paper1842");
    await explorer
      .getByRole("button", {
        name: "External source: Learning relational structure with graph networks",
        exact: true,
      })
      .waitFor();
    await search.fill("");
    for (const mode of ["clusters", "radial", "timeline"]) {
      await explorer.getByLabel("Graph layout").selectOption(mode);
      await page.waitForFunction(
        () => !document.querySelector(".cg-layout-status"),
      );
    }
    await explorer.getByLabel("Paper scope").selectOption("project");
    await explorer.getByLabel("Published since year").fill("2020");
    await explorer.getByRole("button", { name: "Fit graph" }).click();
    await page.screenshot({ path: join(shots, "14-graph-timeline.png") });
    // Hit-test real rendered nodes through pointer interaction, not a DOM substitute.
    await explorer.getByLabel("Published since year").fill("");
    const stage = await explorer.locator(".cg-stage").boundingBox();
    let hit = false;
    if (stage)
      for (let y = 20; y < stage.height - 20 && !hit; y += 18)
        for (let x = 20; x < stage.width - 20 && !hit; x += 18) {
          await page.mouse.move(stage.x + x, stage.y + y);
          if (await explorer.locator(".cg-tooltip").count()) {
            const title = await explorer
              .locator(".cg-tooltip strong")
              .innerText();
            // First move, then force a metadata poll and move again. This catches
            // drag handlers being removed by metadata-only graph refreshes.
            const target = { x: stage.x + x + 60, y: stage.y + y + 35 };
            await page.mouse.down();
            await page.mouse.move(target.x, target.y, { steps: 12 });
            await page.mouse.up();
            await page.mouse.move(target.x + 20, target.y + 20);
            await page.mouse.move(target.x, target.y);
            await page.waitForFunction(
              (title) =>
                document.querySelector(".cg-tooltip strong")?.textContent ===
                title,
              title,
            );
            graph.nodes[0].venue = "Updated venue";
            graph.nodes[0].year += 1;
            // The production poll is 15 seconds when ready.
            await page.waitForResponse((response) =>
              response.url().endsWith(`/research/graph`),
            );
            await page.waitForTimeout(100);
            await page.mouse.move(target.x, target.y);
            await page.mouse.down();
            await page.mouse.move(target.x + 60, target.y + 35, { steps: 12 });
            await page.mouse.up();
            await page.mouse.move(target.x + 80, target.y + 55);
            await page.mouse.move(target.x + 60, target.y + 35);
            await page.waitForFunction(
              (title) =>
                document.querySelector(".cg-tooltip strong")?.textContent ===
                title,
              title,
            );
            await page.waitForTimeout(300);
            await page.mouse.click(target.x + 60, target.y + 35);
            hit = true;
          }
        }
    if (!hit) throw new Error("Could not hit-test a rendered citation node");
    await explorer
      .getByRole("button", { name: "Close paper details" })
      .waitFor();
    await explorer
      .getByRole("tab", { name: "In your draft", exact: true })
      .click();
    await explorer
      .getByText("Fixture passage citing this work.", { exact: true })
      .waitFor();
    await page.screenshot({ path: join(shots, "16-graph-manuscript.png") });
    const downloadPromise = page.waitForEvent("download");
    await explorer.getByRole("button", { name: "Export JSON" }).click();
    const downloaded = await downloadPromise;
    const exported = JSON.parse(
      readFileSync((await downloaded.path())!, "utf8"),
    );
    if (exported.nodes.length !== 5000 || exported.edges.length !== 20000)
      throw new Error("Export omitted graph data");
    await explorer
      .getByRole("button", { name: /Fixture passage citing this work/ })
      .click();
    await page.waitForFunction(() => !document.querySelector("dialog:modal"));
    await page.locator(".cm-content").waitFor();
    // Return to the explorer and check Escape independently from source navigation.
    await page
      .getByRole("tab", { name: "Research", exact: true })
      .first()
      .click();
    await explorer
      .getByRole("button", { name: "Open graph full screen" })
      .click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog:modal"));
    if (
      !(await explorer
        .getByRole("button", { name: "Open graph full screen" })
        .evaluate((el) => el === document.activeElement))
    )
      throw new Error("Fullscreen did not restore keyboard focus");
    await explorer
      .getByRole("button", { name: "Open graph full screen" })
      .click();
    await page.setViewportSize({ width: 600, height: 900 });
    // The parent app switches to its single-pane mode at this breakpoint.
    if (!(await explorer.isVisible())) {
      await page
        .getByRole("tab", { name: "Research", exact: true })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Open graph full screen" })
        .click();
    }
    await page.screenshot({ path: join(shots, "15-graph-mobile.png") });
    if (await explorer.evaluate((el) => el.scrollWidth > el.clientWidth + 2))
      throw new Error("Mobile explorer overflows horizontally");
    if (errors.length) throw new Error(errors.join("; "));
    console.log(
      `Graph explorer passed: 5,000 nodes / 20,000 edges; ready in ${loadMs}ms, author search ${searchMs}ms. Fullscreen, canvas clicks, details, filters, keyboard, export and mobile checked.`,
    );
  } catch (error) {
    await page.screenshot({ path: join(shots, "graph-failure.png") });
    throw error;
  } finally {
    await page.close();
  }
}
