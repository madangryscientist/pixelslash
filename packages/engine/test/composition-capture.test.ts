import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { readManifest } from "../src/manifest.ts";
import { captureSnapshots } from "../src/snapshot.ts";
import { libraryProject, PAGES } from "./composition-fixtures.ts";

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const page = Reflect.get(PAGES, new URL(req.url).pathname.slice(1));
    if (typeof page !== "string") return new Response("not found", { status: 404 });
    return new Response(page, { headers: { "content-type": "text/html" } });
  },
});
const dirs: string[] = [];
let project = "";
beforeAll(async () => {
  project = await libraryProject();
  dirs.push(project);
});
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-composition-capture-"));
  dirs.push(dir);
  return dir;
}

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

const raw = (composition?: unknown) => ({
  baseUrl: `http://127.0.0.1:${server.port}`,
  routes: ["/clean", "/stray", "/marked"],
  variants: [{ name: "desktop", viewport: { width: 800, height: 400 } }],
  ...(composition !== undefined && { composition }),
});

describe("a composition-only capture", { timeout: 60_000 }, () => {
  test("writes each shot's findings to the manifest, and the gap list beside it", async () => {
    const config = parseConfig(raw({ library: "@acme/ui", name: "Acme UI" }));
    const out = await tmp();
    const result = await captureSnapshots(
      { ...config, composition: config.composition && { ...config.composition, from: project } },
      out,
      pinned,
    );
    const manifest = await readManifest(out);
    const by = new Map(manifest.snapshots.map((e) => [e.name, e.composition]));
    expect(by.get("clean")).toEqual({ library: "Acme UI", gaps: [], special: [] });
    expect(by.get("stray")?.gaps.map((g) => [g.selector, g.classes])).toEqual([["#go", ["mt-7"]]]);
    expect(by.get("marked")?.special.map((s) => s.reason)).toEqual([
      "the brand mark is drawn by hand",
    ]);
    expect(result.gapsPath).toBe(join(out, "gaps.html"));
    const list = await Bun.file(join(out, "gaps.json")).json();
    expect(list.gaps).toHaveLength(1);
    expect(list.special).toHaveLength(1);
    const html = await Bun.file(join(out, "gaps.html")).text();
    expect(html).toContain("Acme UI gaps (1)");
    expect(html).toContain("Special cases (1)");
    expect(html).toContain("not from Acme UI: the classes &quot;mt-7&quot;");
  });

  test("any other project's manifest has no composition and no gap list", async () => {
    const out = await tmp();
    const result = await captureSnapshots(parseConfig(raw()), out, pinned);
    const text = await Bun.file(join(out, "manifest.json")).text();
    expect(text).not.toContain("composition");
    expect(result.gapsPath).toBeUndefined();
    expect(await Bun.file(join(out, "gaps.json")).exists()).toBe(false);
    // The manifest an older PixelSlash wrote reads the same way: no field, no findings.
    expect((await readManifest(out)).snapshots.every((e) => e.composition === undefined)).toBe(
      true,
    );
  });

  test("a library that is not installed fails before anything is shot", async () => {
    const config = parseConfig(raw({ library: "@acme/missing" }));
    const out = await tmp();
    await expect(
      captureSnapshots(
        { ...config, composition: config.composition && { ...config.composition, from: project } },
        out,
        pinned,
      ),
    ).rejects.toThrow(/@acme\/missing is not installed/);
    expect(await Bun.file(join(out, "manifest.json")).exists()).toBe(false);
  });
});

describe("the config's composition", () => {
  test("library alone: named after the package, no special cases", () => {
    expect(parseConfig(raw({ library: "@acme/ui" })).composition).toEqual({
      library: "@acme/ui",
      name: "@acme/ui",
      custom: [],
      from: undefined,
    });
    expect(parseConfig(raw()).composition).toBeUndefined();
  });

  test("special cases need a selector and a reason; unknown keys are refused", () => {
    expect(() => parseConfig(raw({ library: "@acme/ui", custom: [{ selector: ".x" }] }))).toThrow(
      "composition.custom[0].reason",
    );
    expect(() => parseConfig(raw({ library: "@acme/ui", strict: true }))).toThrow(
      "composition.strict",
    );
    expect(() => parseConfig(raw({ name: "x" }))).toThrow("composition.library");
  });
});
