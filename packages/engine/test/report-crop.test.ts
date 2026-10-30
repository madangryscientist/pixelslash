import { describe, expect, test } from "vitest";
import type { Region } from "../src/regions.ts";
import { changeCrop } from "../src/report-crop.ts";
import { renderPixelReport } from "../src/report.ts";

const region = (box: [number, number, number, number], kind: Region["kind"] = "change"): Region => {
  const [x, y, w, h] = box;
  return { x, y, w, h, changedPixels: w * h, antialiasedPixels: 0, kind };
};

const base = { changedPixels: 10, specks: { count: 0, pixels: 0 } };

describe("changeCrop", () => {
  test("is the union of the change regions plus 24px, clipped to the overlap", () => {
    const crop = changeCrop([region([100, 200, 10, 10]), region([300, 220, 20, 20])], 1000, 1000);
    expect(crop).toEqual({ x: 76, y: 176, w: 268, h: 88 });
    expect(changeCrop([region([5, 5, 10, 10])], 30, 30)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  });

  test("noise and shift regions pull nothing, and no change region means no crop", () => {
    expect(
      changeCrop([region([0, 0, 4, 4], "noise"), region([50, 50, 4, 4], "shift")], 100, 100),
    ).toBe(null);
    const crop = changeCrop(
      [region([40, 40, 4, 4]), region([900, 900, 4, 4], "noise")],
      1000,
      1000,
    );
    expect(crop).toEqual({ x: 16, y: 16, w: 52, h: 52 });
  });
});

describe("renderPixelReport crop", () => {
  const shots = { main: { width: 400, height: 300 }, branch: { width: 400, height: 300 } };

  test("a changed shot shows Main, Branch and Diff cropped, with the full frame behind a click", () => {
    const html = renderPixelReport({
      ...base,
      regions: [region([100, 100, 20, 10])],
      ...shots,
    });
    expect(html).toContain("Changed region 76,76 68x58");
    expect(html.match(/class="crop"/g)).toHaveLength(3);
    expect(html).toContain("aspect-ratio:68/58");
    // The slab is the whole 400x300 image on a 68x58 window, offset to the crop's corner.
    expect(html).toContain("width:588.235%");
    expect(html).toContain("left:-111.765%");
    expect(html).toContain("<details><summary>Full frame</summary>");
    expect(html).toContain('<img src="main.png" alt="Main">');
    // The region list stays visible: it is not behind the Full frame click.
    expect(html.indexOf('<ol class="regions">')).toBeLessThan(html.indexOf("<details>"));
  });

  test("a shot with no change region keeps the full frame and no crop", () => {
    const html = renderPixelReport({ ...base, regions: [], ...shots });
    expect(html).not.toContain('class="crop"');
    expect(html).not.toContain("<details>");
    expect(html).toContain('<img src="main.png" alt="Main">');
  });

  test("differing sizes crop inside the overlap and the report still states both", () => {
    const html = renderPixelReport({
      ...base,
      regions: [region([350, 250, 40, 40])],
      main: { width: 400, height: 300 },
      branch: { width: 500, height: 280 },
    });
    expect(html).toContain("Main 400x300 · Branch 500x280");
    expect(html).toContain("Changed region 326,226 74x54");
  });
});
