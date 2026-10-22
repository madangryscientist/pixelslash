import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { loadCorpus } from "../src/corpus.ts";
import { type FetchLike, listFlags, listing, resolveApi, run } from "../src/import-flags.ts";
import { runPixelslash } from "../src/pixelslash.ts";
import { scoreTool } from "../src/score.ts";

/** bench:import-flags (ob 1734): a flag on a fake server becomes a case the runner scores. */

const W = 64;
const H = 48;

/** A grey PNG, with a red square at (16, 16) when `square`. */
function png(square: boolean): Buffer {
  const img = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const red = square && x >= 16 && x < 32 && y >= 16 && y < 32;
      img.data[i] = red ? 230 : 200;
      img.data[i + 1] = red ? 20 : 200;
      img.data[i + 2] = red ? 20 : 200;
      img.data[i + 3] = 255;
    }
  return PNG.sync.write(img);
}

const SERVER = "http://ps.test";
const images: Record<string, Buffer> = {
  "/images/plain": png(false),
  "/images/square": png(true),
};

/** A flag whose baseline is plain grey; its head has the square when `changed`. */
function flag(id: string, kind: string, rect: object | null, changed: boolean) {
  const head = changed ? "/images/square" : "/images/plain";
  return {
    id,
    kind,
    note: `note ${id}`,
    rect,
    by: "ada",
    snapshot: { id: `s-${id}`, name: "Home page", platform: "linux", browser: "chromium" },
    build: { id: "b1", branch: "feature", commit_sha: "abc" },
    measured: { diff_status: "unchanged", changed_pixels: 0 },
    images: { head: `${SERVER}${head}`, baseline: `${SERVER}/images/plain`, diff: null },
    created_at: "2026-10-22T09:00:00.000Z",
    updated_at: "2026-10-22T09:00:00.000Z",
    exported_at: null as string | null,
    web_url: `${SERVER}/projects/p1/builds/b1/snapshots/s-${id}`,
  };
}

const flags = [
  flag("missed-rect-0001", "missed", { x: 16, y: 16, w: 16, h: 16 }, true),
  flag("missed-whole-0002", "missed", null, true),
  flag("fp-0003", "false_positive", null, false),
];

const marked: string[] = [];

const fakeServer: FetchLike = async (url, init) => {
  const req = new Request(url, init);
  const path = new URL(req.url).pathname;
  const image = images[path];
  if (image) return new Response(image);
  if (req.headers.get("authorization") !== "Bearer psu_test")
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  if (path === "/api/v1/projects") return Response.json({ projects: [{ id: "p1", name: "web" }] });
  if (path === "/api/v1/projects/p1/detection-flags")
    return Response.json({ detection_flags: flags, next_cursor: null });
  const mark = /^\/api\/v1\/detection-flags\/([^/]+)\/exported$/.exec(path);
  const found = flags.find((f) => f.id === mark?.[1]);
  if (req.method === "POST" && found) {
    found.exported_at = "2026-10-22T10:00:00.000Z";
    marked.push(found.id);
    return Response.json({ detection_flag: found });
  }
  return Response.json({ error: { code: "not_found" } }, { status: 404 });
};

/** The server before ob 1734: no `exported` endpoint. */
const oldServer: FetchLike = async (url, init) =>
  new Request(url, init).method === "POST"
    ? Response.json({ error: "not found" }, { status: 404 })
    : fakeServer(url, init);

const dir = mkdtempSync(join(tmpdir(), "ps-import-flags-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { PIXELSLASH_TOKEN: "psu_test", PIXELSLASH_SERVER: SERVER, HOME: dir };

describe("bench:import-flags (ob 1734)", () => {
  test("imports flags into cases the bench loads and scores, and marks them exported", async () => {
    const to = join(dir, "cases");
    const ids = flags.map((f) => f.id);
    expect(await run(["--to", to, ...ids], env, fakeServer)).toBe(0);
    expect(marked).toEqual(ids);

    const cases = loadCorpus("main", to);
    expect(cases.map((c) => [c.name, c.label, c.box])).toEqual([
      ["flag-false-positive-home-page-fp-0003", "noise", undefined],
      ["flag-missed-home-page-missed-r", "real", { x: 16, y: 16, w: 16, h: 16 }],
      ["flag-missed-home-page-missed-w", "real", { x: 0, y: 0, w: W, h: H }],
    ]);
    const meta: { flag: Record<string, unknown> } = JSON.parse(
      readFileSync(join(to, "flag-missed-home-page-missed-w", "label.json"), "utf8"),
    );
    expect(meta.flag).toMatchObject({
      id: "missed-whole-0002",
      note: "note missed-whole-0002",
      box_from: "whole-image",
      build: { id: "b1", branch: "feature" },
    });

    const results = runPixelslash(cases);
    const rows = cases.map((c) => {
      const pixelslash = results.get(`main/${c.name}`);
      if (!pixelslash) throw new Error(`no result for ${c.name}`);
      return { case: c, pixelslash, argos: null };
    });
    const score = scoreTool(rows, "pixelslash");
    expect(score).toMatchObject({ realCaught: 2, realTotal: 2, noiseFlagged: 0, noiseTotal: 1 });
    expect(score.meanIouCaught).toBeGreaterThan(0);
  });

  test("with no ids it lists only the flags not yet exported", async () => {
    for (const f of flags) f.exported_at = "2026-10-22T10:00:00.000Z";
    flags.push(flag("open-0004", "missed", null, true));
    const api = resolveApi({}, env, fakeServer);
    const out = listing(await listFlags(api));
    expect(out).toContain("1 flag(s) not yet exported");
    expect(out).toContain("open-0004  missed  Home page  feature");
    expect(out).not.toContain("fp-0003");
  });

  test("a server without the exported endpoint keeps the case and says it was not marked", async () => {
    const to = join(dir, "old-server");
    expect(await run(["--to", to, "fp-0003"], env, oldServer)).toBe(1);
    expect(loadCorpus("main", to).map((c) => c.name)).toEqual([
      "flag-false-positive-home-page-fp-0003",
    ]);
  });

  test("a CI token is refused before any request", async () => {
    await expect(run([], { ...env, PIXELSLASH_TOKEN: "psci_x" }, fakeServer)).rejects.toThrow(
      "personal token",
    );
  });
});
