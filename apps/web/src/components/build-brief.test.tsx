// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { render } from "#/test/render";
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

async function show(brief: string | null) {
  const { container, user } = await render(<BuildBrief brief={brief} />);
  return { host: container, user };
}

const q = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const must = (el: HTMLElement | null): HTMLElement => {
  if (!el) throw new Error("not on the page");
  return el;
};

describe("the brief on the build and branch pages", () => {
  test("is the uploader's words as plain text: markdown and a tag are shown as typed, not rendered", async () => {
    const { host } = await show(BRIEF);
    expect(host.textContent).toContain("The uploader's words");
    expect(q(host, "brief-text")?.textContent).toBe(BRIEF);
    expect(host.querySelectorAll("strong, b")).toHaveLength(0);
  });

  test("a long brief opens collapsed, opens on Show all, and folds again on Show less", async () => {
    const { host, user } = await show(BRIEF);
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
    expect(q(host, "brief-toggle")?.textContent).toBe("Show all");
    await user.click(must(q(host, "brief-toggle")));
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(false);
    expect(q(host, "brief-toggle")?.textContent).toBe("Show less");
    await user.click(must(q(host, "brief-toggle")));
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
  });

  test("a short brief is not collapsed and has no toggle; a build without one shows nothing", async () => {
    const { host: short } = await show("Change nothing.");
    expect(q(short, "brief-text")?.textContent).toBe("Change nothing.");
    expect(q(short, "brief-text")?.hasAttribute("data-collapsed")).toBe(false);
    expect(q(short, "brief-toggle")).toBeNull();
    expect((await show(null)).host.innerHTML).toBe("");
  });

  test("past 320 characters on one line is long too", async () => {
    const { host } = await show("x".repeat(321));
    expect(q(host, "brief-text")?.hasAttribute("data-collapsed")).toBe(true);
    expect(q(host, "brief-toggle")).not.toBeNull();
  });
});
