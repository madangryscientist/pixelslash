import { afterAll, describe, expect, test } from "vitest";
import { explainIteration, parseDifferences } from "../src/dev-explain.ts";
import { DEV_PAGE_HTML } from "../src/dev-page-html.ts";
import { DEV_HEADER, serveDevPage } from "../src/dev-page.ts";
import { featurePairs } from "../src/dev-refs.ts";
import { cleanupDev, tmpStore } from "./dev-fixtures.ts";
import { controller, iterationWithRef, visionStub } from "./dev-feature-fixtures.ts";

afterAll(cleanupDev);

/** A feature's review page and the judge's differences in `pixelslash dev` (ob 1741). */

describe("the feature review page", () => {
  test("sizes that differ are both stated, the overlay is the overlap, and nothing is scored", async () => {
    const store = await tmpStore();
    const { session, src } = await iterationWithRef(store, 24);
    const ctl = controller(store, session, { feature: src });
    const it = await ctl.run();
    if (!it) throw new Error("no run");
    const feature = await ctl.feature();
    if (!feature) throw new Error("no feature");
    const [pair] = featurePairs(it, feature);
    expect(pair?.sizes).toBe(
      "reference 24×20 · now 16×16 · sizes differ: the overlay shows only the overlapping 16×16 from the top left",
    );
    expect(pair?.overlap).toEqual({ width: 16, height: 16 });
    const live = serveDevPage(store, "index", ctl);
    try {
      const state: unknown = await (await fetch(`${live.url}/api/state`)).json();
      expect(state).toMatchObject({
        // The mtime goes in the ref's URL, so a refetch reloads the image.
        feature: { spec: { text: "The block is blue." }, refs: [{ modified: expect.any(Number) }] },
        pairs: [{ sizes: expect.stringContaining("reference 24×20 · now 16×16") }],
      });
      const body = JSON.stringify(state);
      expect(body).not.toMatch(/score|match|percent|similar/i);
      const ref = await fetch(`${live.url}/ref/0`);
      expect(ref.status).toBe(200);
      expect((await fetch(`${live.url}/ref/9`)).status).toBe(404);
      const refetch = await fetch(`${live.url}/api/refs`, {
        method: "POST",
        headers: { [DEV_HEADER]: "1" },
      });
      expect(await refetch.json()).toMatchObject({ feature: { refs: [{ index: 0 }] } });
    } finally {
      await ctl.idle();
      await live.stop();
    }
    expect(DEV_PAGE_HTML).not.toMatch(/score|match|percent|similar/i);
    expect(DEV_PAGE_HTML).toContain("Nothing is measured against it");
  });

  test("same sizes say so without a caveat", async () => {
    const store = await tmpStore();
    const { session, src } = await iterationWithRef(store, 16, 16);
    const ctl = controller(store, session, { feature: src });
    const it = await ctl.run();
    const feature = await ctl.feature();
    if (!it || !feature) throw new Error("no run");
    expect(featurePairs(it, feature)[0]?.sizes).toBe("reference 16×16 · now 16×16");
    await ctl.idle();
  });
});

describe("the judge explains the differences", () => {
  test("each difference has an area on the shot, numbered, and there is no verdict", async () => {
    const store = await tmpStore();
    const { session, src } = await iterationWithRef(store, 16);
    const { shown, deps } = visionStub(
      "Here is what I see:\nDIFF 25 50 50 25 the block is red, the spec says blue\nDIFF 0 0 200 10% the header is missing\nPASS",
    );
    const explained: unknown[] = [];
    const ctl = controller(store, session, {
      feature: src,
      judge: { dsDir: undefined, deps },
      onExplain: (_: unknown, d: unknown) => explained.push(d),
    });
    const it = await ctl.run();
    const first = src.def.refs[0];
    const at = {
      name: "index",
      shot: it?.shots[0]?.shot,
      ref: first?.kind === "png" ? first.path : null,
    };
    expect(it?.differences).toEqual({
      status: "done",
      items: [
        {
          n: 1,
          ...at,
          area: { x: 4, y: 8, width: 8, height: 4 },
          what: "the block is red, the spec says blue",
        },
        { n: 2, ...at, area: { x: 0, y: 0, width: 16, height: 2 }, what: "the header is missing" },
      ],
    });
    expect(explained).toHaveLength(1);
    expect(shown[0]).toHaveLength(2);
    expect(JSON.stringify(it?.differences)).not.toMatch(/pass|fail|score|match/i);
    await ctl.idle();
  });

  test("no judge on the machine says skip: no judge and invents nothing", async () => {
    const store = await tmpStore();
    const { session, src } = await iterationWithRef(store, 16);
    const ctl = controller(store, session, { feature: src });
    const it = await ctl.run();
    const feature = await ctl.feature();
    if (!it || !feature) throw new Error("no run");
    const d = await explainIteration(it, feature, { which: () => null });
    expect(d).toEqual({ status: "skipped", reason: "no judge", items: [] });
    await ctl.idle();
  });

  test("an answer with no DIFF lines is no differences, and boxes stay on the shot", () => {
    expect(parseDifferences("NONE", { width: 10, height: 10 })).toEqual([]);
    expect(parseDifferences("DIFF 90 90 50 50 off the edge", { width: 100, height: 100 })).toEqual([
      { area: { x: 90, y: 90, width: 10, height: 10 }, what: "off the edge" },
    ]);
  });
});
