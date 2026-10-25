import { describe, expect, test } from "vitest";
import { type Composition, parseCompositionEntry } from "../src/composition.ts";
import { GAP_COLOUR, SPECIAL_COLOUR, gapReason } from "../src/composition-entry.ts";
import { gapsList, renderGaps } from "../src/composition-report.ts";
import type { SnapshotEntry, SnapshotManifest } from "../src/snapshot.ts";

const entry = (name: string, composition: Composition): SnapshotEntry => ({
  name,
  path: `/${name}`,
  variant: {
    name: "desktop",
    browser: "chromium",
    viewport: { width: 800, height: 400 },
    theme: "light",
  },
  tags: [],
  diff: {},
  ignore: [],
  flaky: "review",
  file: `${name}/desktop.png`,
  fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
  composition,
});

const stray = (box: { x: number; y: number; width: number; height: number }) => ({
  kind: "class" as const,
  selector: "#go",
  tag: "button",
  classes: ["mt-7"],
  style: null,
  box,
});

const bad = (where: string, what: string): never => {
  throw new Error(`${where} ${what}`);
};

describe("the gap list", () => {
  test("the same stray class on two routes is one group with two places", () => {
    const manifest: SnapshotManifest = {
      version: 1,
      snapshots: [
        entry("home", {
          library: "Acme UI",
          gaps: [stray({ x: 1, y: 2, width: 3, height: 4 })],
          special: [],
        }),
        entry("about", {
          library: "Acme UI",
          omitted: 2,
          gaps: [stray({ x: 5, y: 6, width: 7, height: 8 })],
          special: [
            { selector: "#logo", reason: "brand", box: { x: 0, y: 0, width: 9, height: 9 } },
          ],
        }),
      ],
    };
    const list = gapsList(manifest, "Acme UI");
    expect(list.gaps).toHaveLength(1);
    expect(list.omitted).toBe(2);
    expect(renderGaps(list, new Map())).toContain("2 more past the cap of 500 a shot");
    expect(list.gaps[0]?.reason).toBe('not from Acme UI: the classes "mt-7"');
    expect(list.gaps[0]?.places.map((p) => [p.name, p.box.x])).toEqual([
      ["home", 1],
      ["about", 5],
    ]);
    expect(list.special).toEqual([
      {
        name: "about",
        variant: "desktop",
        path: "/about",
        file: "about/desktop.png",
        selector: "#logo",
        reason: "brand",
        box: { x: 0, y: 0, width: 9, height: 9 },
      },
    ]);
  });

  test("the page says what was measured, claims no more, and sends nothing anywhere", () => {
    const manifest: SnapshotManifest = {
      version: 1,
      snapshots: [
        entry("home", {
          library: "Acme UI",
          gaps: [
            stray({ x: 1, y: 2, width: 3, height: 4 }),
            {
              kind: "element",
              selector: "html > body > div",
              tag: "div",
              classes: ["banner", "glow"],
              style: null,
              box: { x: 0, y: 0, width: 20, height: 20 },
            },
          ],
          special: [
            { selector: "#logo", reason: "brand", box: { x: 0, y: 0, width: 9, height: 9 } },
          ],
        }),
      ],
    };
    const list = gapsList(manifest, "Acme UI");
    expect(list.gaps[1]?.reason).toBe('not from Acme UI: the <div> styled "banner glow"');
    const html = renderGaps(list, new Map([["home/desktop.png", { width: 800, height: 400 }]]));
    expect(html).toContain("nothing was sent anywhere");
    expect(html).not.toMatch(/missing|filed|no library root/);
    // Plain kinds, not the field names.
    expect(html).toContain("hand-styled element: <code>banner glow</code>");
    expect(html).toContain("extra classes: <code>mt-7</code>");
    // The server's colours.
    expect(html).toContain(`outline-color: ${GAP_COLOUR}`);
    expect(html).toContain(`outline: 2px dashed ${SPECIAL_COLOUR}`);
    // A 3×4 box (a 20×22 px crop) is drawn at most 6 times as wide, not stretched to the 480 px cap.
    expect(html).toContain("max-width:120px");
  });

  test("gap and special-case wording is plain and says only what the DOM showed", () => {
    const base = { classes: [], style: null };
    expect(gapReason({ ...base, kind: "style", style: "margin-top: 4px" }, "Acme UI")).toBe(
      "inline style: margin-top: 4px",
    );
    expect(
      gapReason({ kind: "element", classes: ["banner"], style: "color: red" }, "Acme UI"),
    ).toBe("hand-styled element: banner; inline style color: red");
    expect(gapReason({ ...base, kind: "class", classes: ["mt-7"] }, "Acme UI")).toBe(
      "extra classes on a Acme UI component: mt-7",
    );
  });

  test("a manifest's composition is validated, and absent reads as no field", () => {
    expect(parseCompositionEntry(undefined, "c", bad)).toBeUndefined();
    const ok = { library: "Acme UI", gaps: [], special: [] };
    expect(parseCompositionEntry(ok, "c", bad)).toEqual(ok);
    expect(() => parseCompositionEntry({ ...ok, gaps: [{ kind: "nope" }] }, "c", bad)).toThrow(
      "c.gaps[0].kind must be element, class, style",
    );
  });
});
