/** App-wide keyboard shortcuts (web/src/shortcuts.ts): which key means what, and when keys are left alone. */
import { describe, expect, it, vi } from "vitest";
import { isTypingTarget, onProofCommand, sendProofCommand, shortcutFor, type KeyLike } from "../../web/src/shortcuts.js";

const body = { tagName: "BODY", closest: () => null };
const press = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: body,
  ...extra,
});

describe("shortcutFor", () => {
  it("maps the documented keys", () => {
    expect(shortcutFor(press("?", { shiftKey: true }))).toEqual({ kind: "help" });
    expect(shortcutFor(press("c"))).toEqual({ kind: "focusChat" });
    expect(shortcutFor(press("1"))).toEqual({ kind: "view", view: "chat" });
    expect(shortcutFor(press("2"))).toEqual({ kind: "view", view: "proof" });
    expect(shortcutFor(press("3"))).toEqual({ kind: "view", view: "source" });
    expect(shortcutFor(press("4"))).toEqual({ kind: "view", view: "pdf" });
    expect(shortcutFor(press("5"))).toEqual({ kind: "view", view: "history" });
    expect(shortcutFor(press("7"))).toEqual({ kind: "view", view: "research" });
    expect(shortcutFor(press("8"))).toBeNull();
    expect(shortcutFor(press("j"))).toEqual({ kind: "nextChange" });
    expect(shortcutFor(press("]"))).toEqual({ kind: "nextChange" });
    expect(shortcutFor(press("k"))).toEqual({ kind: "prevChange" });
    expect(shortcutFor(press("A", { shiftKey: true }))).toEqual({ kind: "approveAll" });
  });

  it("never takes a key with Ctrl, Cmd or Alt (browser and editor shortcuts)", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(shortcutFor(press("s", { [mod]: true }))).toBeNull();
      expect(shortcutFor(press("1", { [mod]: true }))).toBeNull();
      expect(shortcutFor(press("f", { [mod]: true }))).toBeNull();
    }
  });

  it("approve all needs Shift: a plain or caps-locked a does nothing", () => {
    expect(shortcutFor(press("a"))).toBeNull();
    expect(shortcutFor(press("A"))).toBeNull();
  });

  it("leaves keys alone while typing, composing, or when a handler took them", () => {
    expect(shortcutFor(press("j", { target: { tagName: "TEXTAREA" } }))).toBeNull();
    expect(shortcutFor(press("j", { target: { tagName: "INPUT", type: "text" } }))).toBeNull();
    expect(shortcutFor(press("j", { target: { tagName: "SELECT" } }))).toBeNull();
    expect(shortcutFor(press("j", { isComposing: true }))).toBeNull();
    expect(shortcutFor(press("j", { defaultPrevented: true }))).toBeNull();
    // Inside CodeMirror: the content element is a contenteditable div.
    const cm = { tagName: "DIV", isContentEditable: true, closest: () => ({}) };
    expect(shortcutFor(press("?", { target: cm, shiftKey: true }))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("treats buttons, checkboxes and the page as not typing", () => {
    expect(isTypingTarget(body)).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON", closest: () => null })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("finds editors by ancestry", () => {
    const inEditor = { tagName: "SPAN", closest: (s: string) => (s.includes(".cm-editor") ? {} : null) };
    expect(isTypingTarget(inEditor)).toBe(true);
  });
});

describe("Proof command bus", () => {
  it("delivers to the mounted panel", () => {
    const seen = vi.fn();
    const off = onProofCommand(seen);
    sendProofCommand("next");
    expect(seen).toHaveBeenCalledWith("next");
    off();
  });

  it("holds a command until the panel mounts, but not for long", () => {
    vi.useFakeTimers();
    try {
      sendProofCommand("prev");
      const seen = vi.fn();
      const off = onProofCommand(seen);
      expect(seen).toHaveBeenCalledWith("prev");
      off();
      // A stale command (the panel never came) must not fire much later — an
      // approve-all confirmation popping up out of nowhere.
      sendProofCommand("approveAll");
      vi.advanceTimersByTime(10_000);
      const late = vi.fn();
      const off2 = onProofCommand(late);
      expect(late).not.toHaveBeenCalled();
      off2();
    } finally {
      vi.useRealTimers();
    }
  });
});
