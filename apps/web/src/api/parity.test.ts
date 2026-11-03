import {
  parseParityManifest,
  type ParityManifest,
} from "@hackcove/pixelslash-engine/parity-manifest";
import { describe, expect, test } from "vitest";
import { parityShotsOf } from "#/db/parity-columns";
import { RED, shot } from "#/diff/test-shots";
import { buildParityView } from "#/server/parity-view";
import { get } from "./test-read";
import { call, idOf, newBuild } from "./test-support";
import { ANDROID, type Deps, PIXEL, WEB, readBuild, world } from "./twins-support";

/** The parity view (PS-298): one key of a build on web, android and ios, read over the API. */

const IOS = {
  ...PIXEL,
  name: "Button/primary",
  theme: "dark",
  platform: "ios",
  browser: "iPhone 15",
  viewport: "393x852",
  fingerprint: { ...PIXEL.fingerprint, platform: "ios", device: "iPhone 15", scale: "3" },
};
const ANDROID_3X = { ...ANDROID, fingerprint: { ...ANDROID.fingerprint, scale: "3" } };

const fail = (where: string, what: string): never => {
  throw new Error(`${where} ${what}`);
};

/** A metrics file with one `button` part of the given height. */
const metrics = (h: number) =>
  JSON.stringify({
    version: "1.0",
    root: "button",
    parts: { button: { box: { x: 0, y: 0, w: 96, h } } },
  });

const WEB_PNG = shot({
  width: 160,
  height: 120,
  blocks: [{ x: 20, y: 20, w: 60, h: 40, rgb: RED }],
});
/** The same screen at 3x: scale-normalised it is the web shot. */
const SAME_AT_3X = shot({
  width: 480,
  height: 360,
  blocks: [{ x: 60, y: 60, w: 180, h: 120, rgb: RED }],
});
/** A different screen entirely. */
const OTHER_AT_3X = shot({
  width: 480,
  height: 360,
  blocks: [{ x: 300, y: 200, w: 150, h: 140, rgb: [20, 30, 200] }],
});

type Shot = { meta: object; png?: Uint8Array<ArrayBuffer>; metrics?: string };

async function uploadShots(deps: Deps, token: string, shots: Shot[], extra: object = {}) {
  const id = await idOf(await call(deps, "POST /api/v1/builds", token, newBuild(extra)));
  for (const s of shots) {
    const form = new FormData();
    form.set("meta", JSON.stringify(s.meta));
    form.set("file", new File([(s.png ?? WEB_PNG).slice()], "shot.png", { type: "image/png" }));
    if (s.metrics !== undefined)
      form.set("metrics", new File([s.metrics], "metrics.json", { type: "application/json" }));
    expect((await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, form)).status).toBe(200);
  }
  const done = await call(
    deps,
    `POST /api/v1/builds/${id}/finalize`,
    token,
    JSON.stringify({ snapshots: shots.length }),
  );
  expect(done.status).toBe(200);
  return id;
}

type ApiColumn = {
  kind: string;
  platform: string;
  device?: string | null;
  line?: string;
  scale?: number | null;
  physical_size?: { width: number; height: number } | null;
  has_metrics?: boolean;
  image_url?: string;
  similarity?: { score: number | null; text: string } | null;
  label?: string;
};
type ApiParity = {
  name: string;
  theme: string;
  columns: ApiColumn[];
  web_url: string;
  metrics: {
    manifest: boolean;
    notice: string | null;
    pairs: {
      a: { platform: string };
      b: { platform: string };
      status: string;
      lacks: string[];
      mismatches: string[];
      declared: string[];
    }[];
    raw_columns: { platform: string; measured: boolean }[];
    raw: { part: string; field: string; values: (string | null)[] }[];
  };
};

async function parity(deps: Deps, buildId: string, token: string, name = "Button/primary") {
  const query = new URLSearchParams({ name, theme: "dark" });
  const res = await get(deps, `/api/v1/builds/${buildId}/parity?${query}`, token);
  expect(res.status).toBe(200);
  const view: ApiParity = JSON.parse(JSON.stringify(res.body));
  return view;
}

describe("the parity view read", () => {
  test("three platforms: web, android and ios side by side at one physical size, with a hint per native column", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG, metrics: metrics(40) },
      { meta: ANDROID_3X, png: SAME_AT_3X, metrics: metrics(44) },
      { meta: IOS, png: SAME_AT_3X, metrics: metrics(40) },
    ]);
    const view = await parity(deps, id, acme.token);

    expect(view.columns.map((c) => c.platform)).toEqual(["web", "android", "ios"]);
    expect(view.columns.every((c) => c.kind === "shot")).toBe(true);
    // 480 px at 3x and 160 px at 1x are the same 160 logical px.
    expect(view.columns.map((c) => c.physical_size)).toEqual([
      { width: 160, height: 120 },
      { width: 160, height: 120 },
      { width: 160, height: 120 },
    ]);
    expect(view.columns.map((c) => c.scale)).toEqual([null, 3, 3]);
    expect(view.columns.map((c) => c.has_metrics)).toEqual([true, true, true]);
    expect(view.columns[0]?.similarity).toBeNull();
    for (const native of view.columns.slice(1)) {
      expect(native.similarity?.score).toBe(1);
      expect(native.similarity?.text).toBe(
        "similarity 1.00, a hint: fonts render differently by design",
      );
    }
    expect(view.web_url).toContain(`/builds/${id}/parity?name=Button%2Fprimary&theme=dark`);

    const web = view.metrics.pairs.find(
      (p) => p.a.platform === "web" && p.b.platform === "android",
    );
    expect(web?.status).toBe("drift");
    expect(web?.mismatches).toHaveLength(1);
    expect(web?.mismatches[0]).toBe("button height 40 web vs 44 android");
    expect(view.metrics.pairs.find((p) => p.b.platform === "ios")?.status).toBe("clean");
    // No manifest on the server: said once, and the raw numbers stay.
    expect(view.metrics.manifest).toBe(false);
    expect(view.metrics.notice).toMatch(/kept in the repo/);
    expect(view.metrics.raw_columns.map((c) => c.measured)).toEqual([true, true, true]);
    expect(view.metrics.raw.find((r) => r.field.includes("height"))?.values).toEqual([
      "40",
      "44",
      "40",
    ]);
  });

  test("a platform with no twin is a column that says so, never hidden", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG },
      { meta: ANDROID_3X, png: SAME_AT_3X },
    ]);
    const view = await parity(deps, id, acme.token);
    expect(view.columns.map((c) => `${c.platform}:${c.kind}`)).toEqual([
      "web:shot",
      "android:shot",
      "ios:missing",
    ]);
    expect(view.columns[2]?.line).toBe("Button/primary dark has no ios twin");
  });

  test("a web-less key keeps its web column as missing and scores nothing", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [{ meta: ANDROID_3X, png: SAME_AT_3X }]);
    const view = await parity(deps, id, acme.token);
    expect(view.columns[0]).toMatchObject({ kind: "missing", platform: "web" });
    expect(view.columns[1]?.similarity?.score).toBeNull();
    expect(view.columns[1]?.similarity?.text).toBe("no score");
  });

  test("two devices on one side get one column each", async () => {
    const { deps, acme } = await world();
    const pixel9 = {
      ...ANDROID_3X,
      browser: "Pixel 9",
      fingerprint: { ...ANDROID_3X.fingerprint, device: "Pixel 9" },
    };
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG },
      { meta: ANDROID_3X, png: SAME_AT_3X },
      { meta: pixel9, png: OTHER_AT_3X },
    ]);
    const view = await parity(deps, id, acme.token);
    const android = view.columns.filter((c) => c.platform === "android");
    expect(android.map((c) => c.device)).toEqual(["Pixel 8 API 35", "Pixel 9"]);
    expect(android.map((c) => c.kind)).toEqual(["shot", "shot"]);
    // Each has its own score against the one web column.
    expect(android[0]?.similarity?.score).toBe(1);
    expect(android[1]?.similarity?.score).toBeLessThan(1);
    expect(view.columns.filter((c) => c.platform === "ios")).toHaveLength(1);
  });

  test("a side with no metrics file reads not measured, never drift", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG, metrics: metrics(40) },
      { meta: ANDROID_3X, png: SAME_AT_3X },
    ]);
    const view = await parity(deps, id, acme.token);
    const pair = view.metrics.pairs[0];
    expect(pair).toMatchObject({ status: "not_measured", lacks: ["android"], mismatches: [] });
    expect(view.columns.map((c) => c.has_metrics)).toEqual([true, false, undefined]);
    expect(view.metrics.raw_columns.map((c) => c.measured)).toEqual([true, false]);
  });

  test("a declared difference is listed as declared, not as a mismatch", async () => {
    const { db, deps, acme, blobs } = await world();
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG, metrics: metrics(38) },
      { meta: ANDROID_3X, png: SAME_AT_3X, metrics: metrics(40) },
    ]);
    const manifest: ParityManifest = parseParityManifest(
      {
        version: 1,
        differences: {
          "Button/primary": { button: { android: { "box.h": 40 }, web: { "box.h": 38 } } },
        },
      },
      "manifest",
      fail,
    );
    const columns = await parityShotsOf(
      db,
      id,
      { name: "Button/primary", theme: "dark" },
      { crossProject: true },
    );
    const view = await buildParityView({
      columns,
      orgId: acme.org.id,
      store: blobs.store,
      sign: async (key) => key,
      manifest,
    });
    expect(view.metrics.manifest).toBe(true);
    expect(view.metrics.notice).toBeNull();
    const [pair] = view.metrics.pairs;
    expect(pair?.status).toBe("clean");
    expect(pair?.mismatches).toEqual([]);
    expect(pair?.declared).toHaveLength(1);
  });

  test("the key must be named, and a key the build does not hold is a 404", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [{ meta: WEB, png: WEB_PNG }]);
    expect((await get(deps, `/api/v1/builds/${id}/parity?name=x`, acme.token)).status).toBe(400);
    expect(
      (await get(deps, `/api/v1/builds/${id}/parity?name=nope&theme=dark`, acme.token)).status,
    ).toBe(404);
    expect(
      (await get(deps, `/api/v1/builds/${id}/parity?name=Button/primary&theme=dark`, null)).status,
    ).toBe(401);
  });

  test("a CI token reads its own project's build only; a user token reaches the twin project", async () => {
    const { deps, acme, ada, eve } = await world();
    const id = await uploadShots(deps, acme.token, [{ meta: WEB, png: WEB_PNG }]);
    expect((await parity(deps, id, acme.token)).columns[0]?.platform).toBe("web");
    expect((await parity(deps, id, ada)).columns[0]?.platform).toBe("web");
    const stranger = await get(
      deps,
      `/api/v1/builds/${id}/parity?name=Button/primary&theme=dark`,
      eve,
    );
    expect(stranger.status).toBe(404);
  });
});

describe("the similarity score is a hint", () => {
  test("a low score leaves the build read exactly as it was, and appears nowhere in it", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [
      { meta: WEB, png: WEB_PNG },
      { meta: ANDROID_3X, png: OTHER_AT_3X },
    ]);
    const before = JSON.stringify(await readBuild(deps, id, acme.token));
    const view = await parity(deps, id, acme.token);
    const score = view.columns[1]?.similarity?.score;
    expect(score).not.toBeNull();
    expect(score).toBeLessThan(0.9);
    const after = JSON.stringify(await readBuild(deps, id, acme.token));
    expect(after).toBe(before);
    expect(after).not.toMatch(/similarity/i);
    // The build's own status is the pixel diff's and the finalize's, not the hint's.
    const build: { status?: string } = JSON.parse(after);
    expect(build.status).toBe("changes");
  });
});

describe("a web-only project", () => {
  test("is unchanged: the build read carries no twins section", async () => {
    const { deps, acme } = await world();
    const id = await uploadShots(deps, acme.token, [{ meta: WEB, png: WEB_PNG }]);
    const build = await readBuild(deps, id, acme.token);
    expect("twins" in build).toBe(false);
    expect(JSON.stringify(build)).not.toMatch(/parity|similarity/i);
  });
});
