import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadConfig, parseConfig } from "../src/config.ts";
import { type FeatureSource, resolveRefs } from "../src/dev-refs.ts";
import { devController } from "../src/dev-session.ts";
import { loadDevConfig } from "../src/dev-target.ts";
import { base, solid } from "./dev-feature-fixtures.ts";
import { cleanupDev, fakeSession, tmpDir, tmpStore } from "./dev-fixtures.ts";

afterAll(cleanupDev);

/** A feature's spec and refs in `pixelslash dev` (ob 1741): the config, Figma refs and inline images. */

const FIGMA = "https://www.figma.com/design/AbC123/Shop?node-id=1-2";

async function configIn(dir: string, features: unknown): Promise<string> {
  const path = join(dir, "pixelslash.config.json");
  await writeFile(path, JSON.stringify({ ...base, features }));
  return path;
}

/** Figma's three calls (the node, the image URL, the raster), counted. */
function figmaStub(raster: Buffer) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url.includes("/nodes"))
      return Response.json({
        nodes: { "1:2": { document: { absoluteBoundingBox: { width: 8 } } } },
      });
    if (url.includes("/images/")) return Response.json({ images: { "1:2": "https://cdn/x.png" } });
    return new Response(new Uint8Array(raster));
  };
  return { calls, fetch };
}

describe("features config", () => {
  test("a spec and refs per target, a ref tied to a viewport or theme, paths beside the config", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "cart.md"), "# Cart\nThe button is red.");
    await writeFile(join(dir, "cart.png"), solid(16, 16));
    const config = await loadConfig(
      await configIn(dir, {
        index: {
          spec: "cart.md",
          refs: ["cart.png", { src: FIGMA, viewport: "wide" }, { src: "cart.png", theme: "dark" }],
        },
        about: { refs: [{ src: "cart.png", viewport: "16x16" }] },
      }),
    );
    expect(config.features.index).toEqual({
      spec: join(dir, "cart.md"),
      refs: [
        { kind: "png", path: join(dir, "cart.png") },
        { kind: "figma", url: FIGMA, fileKey: "AbC123", nodeId: "1:2", viewport: "wide" },
        { kind: "png", path: join(dir, "cart.png"), theme: "dark" },
      ],
    });
    expect(config.features.about?.refs[0]).toMatchObject({ viewport: "16x16" });
    expect(parseConfig(base).features).toEqual({});
  });

  test("a bad path or URL is rejected, naming the key, and a missing file the config", async () => {
    const dir = await tmpDir();
    const load = async (features: unknown) => loadConfig(await configIn(dir, features));
    await expect(load({ index: { refs: ["https://example.com/x.png"] } })).rejects.toThrow(
      "features.index.refs[0].src is not a Figma frame URL",
    );
    await expect(load({ index: { refs: ["https://www.figma.com/design/K/x"] } })).rejects.toThrow(
      "features.index.refs[0].src is not a Figma frame URL",
    );
    await expect(load({ index: { refs: ["cart.jpg"] } })).rejects.toThrow(
      "features.index.refs[0].src must be a .png path",
    );
    await expect(load({ index: { spec: "spec.txt" } })).rejects.toThrow(
      "features.index.spec must be a path to a markdown (.md) file",
    );
    await expect(load({ index: { refs: [{ src: "a.png", viewport: "huge" }] } })).rejects.toThrow(
      "features.index.refs[0].viewport must be WxH or a variant name",
    );
    await expect(load({ index: { refs: [{ src: "a.png", colour: "x" }] } })).rejects.toThrow(
      "features.index.refs[0].colour is not a ref option",
    );
    const path = join(dir, "pixelslash.config.json");
    // Only dev reads them: capture and check load a config whose ref is not on this machine.
    await expect(load({ index: { refs: ["gone.png"] } })).resolves.toBeDefined();
    const dev = async (features: unknown) =>
      loadDevConfig(await configIn(dir, features), undefined);
    await expect(dev({ index: { refs: ["gone.png"] } })).rejects.toThrow(
      `features.index.refs[0].src names ${join(dir, "gone.png")}, which does not exist (config ${path})`,
    );
    await expect(dev({ index: { spec: "gone.md" } })).rejects.toThrow(
      `features.index.spec names ${join(dir, "gone.md")}, which does not exist (config ${path})`,
    );
  });
});

describe("feature refs", () => {
  const variants = parseConfig(base).variants;
  const figmaOnly = {
    spec: undefined,
    refs: [{ kind: "figma" as const, url: FIGMA, fileKey: "AbC123", nodeId: "1:2" }],
  };

  test("a Figma frame is rendered at the viewport width × DPR, cached, and re-fetched only when asked", async () => {
    const store = await tmpStore();
    const { calls, fetch } = figmaStub(solid(32, 32));
    const opts = { store, variants, dpr: 2, figma: { token: "t", fetch }, refresh: false };
    const first = await resolveRefs(figmaOnly, opts);
    expect(first.map((r) => [r.variant, r.skip])).toEqual([
      ["small", null],
      ["wide", null],
    ]);
    expect(first[0]?.file).toContain(join(store.root, "refs", "figma-"));
    expect(first[0]?.file).not.toBe(first[1]?.file);
    // Two widths, three calls each; the scale asked for is width × DPR over the frame's 8 px.
    expect(calls).toHaveLength(6);
    expect(
      calls.filter((u) => u.includes("scale=")).map((u) => new URL(u).searchParams.get("scale")),
    ).toEqual(["4", "4"]);
    await resolveRefs(figmaOnly, opts);
    expect(calls).toHaveLength(6);
    await resolveRefs(figmaOnly, { ...opts, refresh: true });
    expect(calls).toHaveLength(12);
  });

  test("with no token the ref is skipped and the rest carry on; a cached render still stands", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "a.png"), solid(16, 16));
    const store = await tmpStore();
    const { calls, fetch } = figmaStub(solid(16, 16));
    const feature = {
      spec: undefined,
      refs: [
        ...figmaOnly.refs,
        { kind: "png" as const, path: join(dir, "a.png"), viewport: "small" },
      ],
    };
    const opts = { store, variants, dpr: 1, figma: { token: undefined, fetch }, refresh: false };
    const refs = await resolveRefs(feature, opts);
    expect(refs.map((r) => r.skip)).toEqual(["no figma token", "no figma token", null]);
    expect(refs[2]?.size).toEqual({ width: 16, height: 16 });
    expect(calls).toHaveLength(0);
    await resolveRefs(feature, { ...opts, figma: { token: "t", fetch } });
    const refreshed = await resolveRefs(feature, { ...opts, refresh: true });
    expect(refreshed.map((r) => r.skip)).toEqual([null, null, null]);
  });

  test("a save does not re-fetch; f does", async () => {
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const { calls, fetch } = figmaStub(solid(16, 16));
    const narrowed = parseConfig({ ...base, variants: [base.variants[0]] }).variants;
    const feature: FeatureSource = {
      def: figmaOnly,
      store,
      variants: narrowed,
      dpr: 1,
      figma: { token: "t", fetch },
    };
    const ctl = devController({
      store,
      session,
      target: "index",
      maxBytes: 1e9,
      main: undefined,
      noMain: "",
      againstMain: false,
      judge: undefined,
      feature,
      refreshRefs: false,
      onRun: () => {},
      onJudge: () => {},
      onExplain: () => {},
      onRefs: () => {},
      onError: () => {},
    });
    await ctl.feature();
    await ctl.run();
    await ctl.run();
    await ctl.feature();
    expect(calls).toHaveLength(3);
    await ctl.refreshRefs();
    expect(calls).toHaveLength(6);
    await ctl.idle();
  });

  test("a resolve that fails is tried again, and a run without --judge does not resolve at all", async () => {
    const dir = await tmpDir();
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const errors: unknown[] = [];
    const path = join(dir, "late.png");
    const ctl = devController({
      store,
      session,
      target: "index",
      maxBytes: 1e9,
      main: undefined,
      noMain: "",
      againstMain: false,
      judge: undefined,
      feature: {
        def: { spec: undefined, refs: [{ kind: "png", path }] },
        store,
        variants: parseConfig({ ...base, variants: [base.variants[0]] }).variants,
        dpr: 1,
        figma: { token: undefined, fetch: async () => new Response() },
      },
      refreshRefs: false,
      onRun: () => {},
      onJudge: () => {},
      onExplain: () => {},
      onRefs: () => {},
      onError: (e) => errors.push(e),
    });
    await expect(ctl.feature()).rejects.toThrow("late.png");
    expect(await ctl.run()).toBeDefined();
    expect(errors).toEqual([]);
    await writeFile(path, solid(16, 16));
    expect((await ctl.feature())?.refs[0]?.size).toEqual({ width: 16, height: 16 });
    await ctl.idle();
  });
});
