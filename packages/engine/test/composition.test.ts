import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import type { Browser } from "playwright";
import { launchChromium } from "../src/capture.ts";
import {
  classChunks,
  loadLibrary,
  stringLiterals,
  styleProps,
  type CompositionLibrary,
} from "../src/composition-library.ts";
import {
  MAX_FINDINGS,
  MAX_TEXT,
  measureComposition,
  type Composition,
} from "../src/composition.ts";
import { libraryProject, PAGES } from "./composition-fixtures.ts";

let project = "";
let browser: Browser;
let lib: CompositionLibrary;
beforeAll(async () => {
  project = await libraryProject();
  browser = await launchChromium();
  lib = await loadLibrary({ library: "@acme/ui", name: "Acme UI", custom: [], from: project });
});
afterAll(async () => {
  await browser?.close();
  await rm(project, { recursive: true, force: true });
});

const warn = (m: string) => {
  throw new Error(m);
};

/** The findings on `html` at 800×400, device scale `scale`. */
async function measure(html: string, scale = 1, library = lib): Promise<Composition> {
  const context = await browser.newContext({
    viewport: { width: 800, height: 400 },
    deviceScaleFactor: scale,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    return await measureComposition(page, library, {
      scale,
      image: { width: 800 * scale, height: 400 * scale },
      warn,
    });
  } finally {
    await context.close();
  }
}

describe("the library's class strings", () => {
  test("string literals skip comments; a template gives its static parts, without a token cut by a hole", () => {
    const src = '// "no"\n/* "no" */ a("x y", \'z\'); b(`p ${q ? "r" : "s"} t-${u}v w`);';
    // `t-` runs into a hole and `v` out of one: neither is a whole class.
    expect(stringLiterals(src)).toEqual(["x y", "z", "p ", "r", "s", "", "w"]);
  });

  test("only literals made of class-like tokens are chunks", () => {
    expect(
      classChunks(["flex gap-2", "gap-2 flex", "Save changes?", "", "hover:bg-[#fff] p-1"]),
    ).toEqual([
      ["flex", "gap-2"],
      ["hover:bg-[#fff]", "p-1"],
    ]);
  });

  test("the inline style props the library sets, shorthand or keyed", () => {
    expect(
      styleProps("({ style: { backgroundColor, color: tone } }); r.style.colorScheme = s;"),
    ).toEqual(["background-color", "color", "color-scheme"]);
  });

  test("an installed package is read, its own dependencies are not", () => {
    expect(lib.name).toBe("Acme UI");
    expect(lib.chunks).toContainEqual(["inline-flex", "items-center", "px-3", "rounded"]);
    expect(lib.chunks).toContainEqual(["card", "p-4"]);
    expect(lib.chunks.flat()).not.toContain("mt-7");
    expect(lib.chunks.flat()).not.toContain("shadow-lg");
    expect(lib.styleProps).toEqual(["background-color"]);
  });

  test("a library that is not installed is a usage error naming it", async () => {
    await expect(
      loadLibrary({ library: "@acme/missing", name: "x", custom: [], from: project }),
    ).rejects.toThrow(/composition\.library @acme\/missing is not installed/);
  });
});

describe("the DOM walk", () => {
  test("a page built only from the library has no findings", async () => {
    expect(await measure(PAGES.clean)).toEqual({ library: "Acme UI", gaps: [], special: [] });
  });

  test("an inline style is one gap, with its selector and box", async () => {
    const { gaps } = await measure(PAGES.inline);
    expect(gaps).toEqual([
      {
        kind: "style",
        selector: "html > body > main > p:nth-of-type(2)",
        tag: "p",
        classes: [],
        style: "color: rgb(200, 0, 0)",
        box: { x: 10, y: 50, width: 200, height: 30 },
      },
    ]);
  });

  test("a stray utility class on a library element is one gap, the library's own classes not in it", async () => {
    const { gaps } = await measure(PAGES.stray);
    expect(gaps).toEqual([
      {
        kind: "class",
        selector: "#go",
        tag: "button",
        classes: ["mt-7"],
        style: null,
        box: { x: 20, y: 40, width: 100, height: 24 },
      },
    ]);
  });

  test("a hand-rolled styled element is one gap, boxed in image px at the device scale", async () => {
    const { gaps } = await measure(PAGES.handRolled, 2);
    expect(gaps).toEqual([
      {
        kind: "element",
        selector: "html > body > div",
        tag: "div",
        classes: ["banner", "glow"],
        style: null,
        box: { x: 60, y: 120, width: 600, height: 80 },
      },
    ]);
  });

  test("a styled <html> or <body> is walked through but is no gap", async () => {
    const { gaps } = await measure(PAGES.rootStyled);
    expect(gaps.map((g) => [g.tag, g.selector])).toEqual([["button", "#go"]]);
  });

  test("a one-class library string does not make an element the library's", async () => {
    // "relative" is a whole library string, so it covers itself; the element is still the app's,
    // and its inline style is not excused as one the library sets.
    const { gaps } = await measure(PAGES.oneClass);
    expect(gaps).toEqual([
      {
        kind: "element",
        selector: "#hero",
        tag: "div",
        classes: ["mt-7"],
        style: "background-color: blue",
        box: { x: 0, y: 0, width: 100, height: 50 },
      },
    ]);
  });

  test("a marked element is one special case with its reason, and its insides are not walked", async () => {
    expect(await measure(PAGES.marked)).toEqual({
      library: "Acme UI",
      gaps: [],
      special: [
        {
          selector: "html > body > div",
          reason: "the brand mark is drawn by hand",
          box: { x: 5, y: 5, width: 64, height: 64 },
        },
      ],
    });
  });

  test("a page past the cap keeps MAX_FINDINGS and counts the rest; a long style is cut", async () => {
    const url = `url("data:image/png;base64,${"A".repeat(MAX_TEXT)}")`;
    // Stacked at the origin: an element off the image is not a finding.
    const many = `<p style="color: red; position: absolute; top: 0; margin: 0">x</p>`.repeat(
      MAX_FINDINGS + 2,
    );
    const found = await measure(
      `<main>${many}<div style='background-image: ${url}'>y</div></main>`,
    );
    expect(found.gaps).toHaveLength(MAX_FINDINGS);
    expect(found.omitted).toBe(3);
    const long = await measure(`<div style='background-image: ${url}'>y</div>`);
    expect(long.gaps[0]?.style).toHaveLength(MAX_TEXT);
    expect(long.gaps[0]?.style?.endsWith("…")).toBe(true);
    expect(long.omitted).toBeUndefined();
  });

  test("a config entry by selector is a special case too; a bad selector warns", async () => {
    const custom = [{ selector: "#go", reason: "a one-off call to action" }];
    const found = await measure(PAGES.stray, 1, { ...lib, custom });
    expect(found.gaps).toEqual([]);
    expect(found.special).toEqual([
      {
        selector: "#go",
        reason: "a one-off call to action",
        box: { x: 20, y: 40, width: 100, height: 24 },
      },
    ]);
    await expect(
      measure(PAGES.stray, 1, { ...lib, custom: [{ selector: "##", reason: "x" }] }),
    ).rejects.toThrow('composition.custom selector "##" is not a valid selector');
  });
});
