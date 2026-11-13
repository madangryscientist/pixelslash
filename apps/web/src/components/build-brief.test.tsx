// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { BuildBrief } from "./build-brief";

/**
 * A build's brief (PS-232) as the build and branch pages draw it: the uploader's words as plain
 * text, collapsed past a few lines, with a toggle. It decides nothing, so it is only drawn.
 */

const BRIEF = [
  "Nudge the **hero** text.",
  "<b>Not bold</b>",
  "Line three.",
  "Line four.",
  "Line five: only shown once the brief is opened.",
].join("\n");

const mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement }[] = [];

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

function show(brief: string | null): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => root.render(<BuildBrief brief={brief} />));
  return host;
}

const q = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("the brief on the build and branch pages", () => {
  test("is the uploader's words as plain text: markdown and a tag are shown as typed, not rendered", () => {
    const host = show(BRIEF);
    expect(host.textContent).toContain("The uploader's words");
    expect(q(host, "brief-text")?.textContent).toBe(BRIEF);
    expect(host.querySelectorAll("strong, b")).toHaveLength(0);
  });

  test("a long brief opens collapsed, opens on Show all, and folds again on Show less", () => {
    const host = show(BRIEF);
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
    expect(q(host, "brief-toggle")?.textContent).toBe("Show all");
    act(() => q(host, "brief-toggle")?.click());
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(false);
    expect(q(host, "brief-toggle")?.textContent).toBe("Show less");
    act(() => q(host, "brief-toggle")?.click());
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
  });

  test("a short brief is not collapsed and has no toggle; a build without one shows nothing", () => {
    const short = show("Change nothing.");
    expect(q(short, "brief-text")?.textContent).toBe("Change nothing.");
    expect(q(short, "brief-text")?.hasAttribute("data-collapsed")).toBe(false);
    expect(q(short, "brief-toggle")).toBeNull();
    expect(show(null).innerHTML).toBe("");
  });

  test("past 320 characters on one line is long too", () => {
    const host = show("x".repeat(321));
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
    expect(q(host, "brief-toggle")).not.toBeNull();
  });
});
