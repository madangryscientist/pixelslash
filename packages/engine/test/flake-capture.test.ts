import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { captureInto, openCaptureSession, recapture, type SnapshotEntry } from "../src/snapshot.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { FP, gitOpts, repo, cleanup } from "./upload-fixtures.ts";

/**
 * The flake check on a real browser (ob 1737): a page that puts a box somewhere new on every load
 * is flaky, with the box as the moving region; a page that renders the same every time but
 * differs from its baseline is a real change, captured again only the default twice.
 */

const SITE = fileURLToPath(new URL("../../../fixtures/capture/site", import.meta.url));
/**
 * `/random` is handed a new left on every load, one pixel on from the one before, so no two loads
 * in a run can land on the same x: a position the page drew itself could repeat one (1 in 600),
 * and a re-capture that matched run 1 does not count as differed. There is room for 660 lefts
 * before the box would leave the viewport, and a run that asks for more fails, not reuses one.
 */
const LEFTS = 660;
let randomLoads = 0;
const OPENING = '<html lang="en">';
const site = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const name = path === "/" ? "index" : path.slice(1);
    const file = Bun.file(join(SITE, `${name}.html`));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    if (name !== "random") return new Response(file, { headers: { "content-type": "text/html" } });
    const page = await file.text();
    if (!page.includes(OPENING))
      throw new Error('random.html has no <html lang="en"> for data-left');
    if (randomLoads === LEFTS) throw new Error(`/random was loaded more than ${LEFTS} times`);
    const left = 24 + randomLoads++;
    const html = page.replace(OPENING, `<html lang="en" data-left="${left}">`);
    return new Response(html, { headers: { "content-type": "text/html" } });
  },
});
let out = "";
afterAll(async () => {
  await site.stop(true);
  if (out) await rm(out, { recursive: true, force: true });
  await cleanup();
});

/** A white page the size of the viewport: every fixture differs from it. */
function white(): Buffer {
  const img = new PNG({ width: 800, height: 400 });
  img.data.fill(255);
  return PNG.sync.write(img);
}

const picked = {
  id: "s0",
  image_url: "/images/orgs/o/s0.png?exp=1&sig=s",
  fingerprint: FP,
  ignore: [],
};

function server() {
  return fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: "server" }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const keys: unknown = Reflect.get(Object(c.body), "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      return Response.json({
        api_version: 1,
        diff_location: "server",
        baselines: keys.map((key) => ({ key, baseline: picked, carry: null, accepted: null })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(white());
    return undefined;
  });
}

describe("capture --upload re-captures through the browser it captured with", () => {
  test("a random page is flaky where the box moved; a stable change is a change", async () => {
    const config = parseConfig({
      baseUrl: `http://127.0.0.1:${site.port}`,
      routes: [{ path: "/random", flaky: "skip" }, "/"],
      variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
    });
    const session = await openCaptureSession(config, {
      env: { PIXELSLASH_IMAGE_VERSION: "test" },
      listFonts: async () => [],
    });
    out = await mkdtemp(join(tmpdir(), "pixelslash-flake-"));
    const asked: string[] = [];
    const fake = server();
    try {
      await captureInto(session, out);
      const { dir: cwd } = await repo(1, 1);
      const result = await uploadSnapshots(
        { dir: out, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
        {
          fetch: fake.fetch,
          recapture: (e: SnapshotEntry) => {
            asked.push(e.name);
            return recapture(session, e);
          },
        },
      );
      expect(asked.toSorted()).toEqual(["index", "index", "random", "random"]);
      expect(result.changed.map((e) => e.name)).toEqual(["index"]);
      const [flaky, ...more] = result.flaky;
      expect(more).toEqual([]);
      expect(flaky?.entry.name).toBe("random");
      expect(flaky?.record).toMatchObject({ runs: 3, differed: [2, 3], policy: "skip" });
      // The box is 60px at y 120: the regions between runs sit on that band and nowhere else.
      for (const { regions } of flaky?.record.regions ?? []) {
        expect(regions.length).toBeGreaterThan(0);
        for (const r of regions) {
          expect(r.y).toBeGreaterThanOrEqual(110);
          expect(r.y + r.h).toBeLessThanOrEqual(190);
        }
      }
      const put = fake.calls.find((c) => c.method === "PUT" && metaOf(c.body).name === "random");
      expect(Reflect.get(metaOf(put?.body), "flake")).toMatchObject({ policy: "skip" });
    } finally {
      await session.close();
    }
  }, 60_000);
});
