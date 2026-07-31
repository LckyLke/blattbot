import { describe, expect, it } from "vitest";
import { nextTabIndex, tabStripKeyDown, type TabStripEl } from "../../web/src/a11y.js";

describe("nextTabIndex", () => {
  it("moves right and wraps at the end", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
  });

  it("moves left and wraps at the start", () => {
    expect(nextTabIndex("ArrowLeft", 2, 3)).toBe(1);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("Home and End jump to the ends", () => {
    expect(nextTabIndex("Home", 2, 5)).toBe(0);
    expect(nextTabIndex("End", 1, 5)).toBe(4);
  });

  it("ignores unrelated keys and impossible positions", () => {
    expect(nextTabIndex("Enter", 1, 3)).toBeNull();
    expect(nextTabIndex("ArrowDown", 1, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", -1, 3)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

/** A fake strip of `count` tabs recording focus/click calls per tab index. */
function makeStrip(count: number, disabled: number[] = []) {
  const calls: string[] = [];
  const tabs: TabStripEl[] = [];
  const strip: TabStripEl = {
    closest: () => null,
    querySelectorAll: (sel) => (sel === '[role="tab"]' ? tabs : []),
    hasAttribute: () => false,
  };
  for (let i = 0; i < count; i++) {
    tabs.push({
      closest: (sel) => (sel === '[role="tablist"]' ? strip : null),
      querySelectorAll: () => [],
      hasAttribute: (name) => name === "disabled" && disabled.includes(i),
      focus: () => calls.push(`focus:${i}`),
      click: () => calls.push(`click:${i}`),
    });
  }
  const press = (key: string, from: number) => {
    let prevented = false;
    tabStripKeyDown({
      key,
      currentTarget: tabs[from],
      preventDefault: () => {
        prevented = true;
      },
    });
    return { prevented, calls: calls.splice(0) };
  };
  return { press };
}

describe("tabStripKeyDown", () => {
  it("ArrowRight focuses and selects the next tab", () => {
    const { press } = makeStrip(3);
    expect(press("ArrowRight", 0)).toEqual({ prevented: true, calls: ["focus:1", "click:1"] });
  });

  it("ArrowLeft wraps from the first to the last tab", () => {
    const { press } = makeStrip(3);
    expect(press("ArrowLeft", 0)).toEqual({ prevented: true, calls: ["focus:2", "click:2"] });
  });

  it("Home and End jump to the ends", () => {
    const { press } = makeStrip(4);
    expect(press("Home", 2).calls).toEqual(["focus:0", "click:0"]);
    expect(press("End", 2).calls).toEqual(["focus:3", "click:3"]);
  });

  it("skips disabled tabs", () => {
    const { press } = makeStrip(3, [1]);
    expect(press("ArrowRight", 0).calls).toEqual(["focus:2", "click:2"]);
  });

  it("leaves unrelated keys alone (no preventDefault, no moves)", () => {
    const { press } = makeStrip(3);
    expect(press("Enter", 1)).toEqual({ prevented: false, calls: [] });
    expect(press("Tab", 1)).toEqual({ prevented: false, calls: [] });
  });

  it("does nothing outside a tablist", () => {
    let prevented = false;
    const lone: TabStripEl = {
      closest: () => null,
      querySelectorAll: () => [],
      hasAttribute: () => false,
    };
    tabStripKeyDown({
      key: "ArrowRight",
      currentTarget: lone,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
  });
});
