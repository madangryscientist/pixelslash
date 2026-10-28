import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffA11y } from "../src/a11y-entry.ts";
import { compareSnapshots } from "../src/compare-snapshots.ts";
import { parseConfig } from "../src/config.ts";
import { readManifest } from "../src/manifest.ts";
import { captureSnapshots, openCaptureSession, type SnapshotDeps } from "../src/snapshot.ts";

/**
 * Accessibility per shot (PS-238), against a real browser. The pages carry a known colour-contrast
 * violation (grey on white) and a known missing-label violation (an input with no name).
 */

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>a11y</title>
<style>body { margin: 0; background: #fff; font: 16px sans-serif; }</style></head>
<body><main>${body}</main></body></html>`;

const LOW_CONTRAST = `<p id="faint" style="color:#bbb">Faint text on white</p>`;
const NO_LABEL = `<input id="email" type="text">`;
const OK_CONTRAST = `<p style="color:#111">Plain text on white</p>`;
const LABELLED = `<label for="email">Email</label><input id="email" type="text">`;

const PAGES: Record<string, { html: string; csp?: string }> = {
  "/broken": { html: page(`<h1>Sign in</h1>${LOW_CONTRAST}${NO_LABEL}`) },
  "/fixed": { html: page(`<h1>Sign in</h1>${OK_CONTRAST}${LABELLED}`) },
  "/contrast-only": { html: page(`<h1>Sign in</h1>${LOW_CONTRAST}${LABELLED}`) },
  // A page that ticks on a timer, under the default paused clock, and forbids inline scripts.
  "/strict": {
    html: page(
      `<h1>Strict</h1>${LOW_CONTRAST}${NO_LABEL}<script>setInterval(() => {}, 10)</script>`,
    ),
    csp: "script-src 'self'",
  },
};

let root = "";
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const found = PAGES[new URL(req.url).pathname];
    if (!found) return new Response("not found", { status: 404 });
    return new Response(found.html, {
      headers: {
        "content-type": "text/html",
        ...(found.csp && { "content-security-policy": found.csp }),
      },
    });
  },
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pixelslash-a11y-"));
});
afterAll(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const pinned: SnapshotDeps = {
  env: { PIXELSLASH_IMAGE_VERSION: "test" },
  listFonts: async () => [],
};

async function capture(path: string, a11y: boolean | undefined) {
  const config = parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [{ path, name: "page" }],
    variants: [{ name: "desktop", viewport: { width: 600, height: 300 } }],
    ...(a11y !== undefined && { a11y }),
  });
  const out = await mkdtemp(join(root, "out-"));
  await captureSnapshots(config, out, pinned);
  return { out, manifest: await readManifest(out) };
}

describe("a11y scan at capture", { timeout: 60_000 }, () => {
  test("finds the contrast and missing-label violations, and they survive the manifest round trip", async () => {
    const { manifest } = await capture("/broken", true);
    const rules = manifest.snapshots[0]?.a11y?.violations.map((v) => v.rule).toSorted();
    expect(rules).toEqual(["color-contrast", "label"]);
    const contrast = manifest.snapshots[0]?.a11y?.violations.find(
      (v) => v.rule === "color-contrast",
    );
    expect(contrast?.selector).toBe("#faint");
    expect(contrast?.impact).toBe("serious");
  });

  test("a clean page is scanned and has no violations (the field is there, empty)", async () => {
    const { manifest } = await capture("/fixed", true);
    expect(manifest.snapshots[0]?.a11y).toEqual({ violations: [] });
  });

  test("off by default: nothing runs and the manifest claims nothing", async () => {
    const off = await capture("/broken", undefined);
    expect(off.manifest.snapshots[0]).not.toHaveProperty("a11y");
    const explicit = await capture("/broken", false);
    expect(explicit.manifest.snapshots[0]).not.toHaveProperty("a11y");
  });

  test("a plain shoot (a flake re-capture, a dev loop) does not scan, even with the config on", async () => {
    const config = parseConfig({
      baseUrl: `http://127.0.0.1:${server.port}`,
      routes: [{ path: "/broken", name: "page" }],
      variants: [{ name: "desktop", viewport: { width: 600, height: 300 } }],
      a11y: true,
    });
    const session = await openCaptureSession(config, pinned);
    try {
      const [route] = session.routes;
      const [variant] = config.variants;
      if (!route || !variant) throw new Error("no route or variant");
      expect((await session.shoot(route, variant)).a11y).toBeUndefined();
      expect((await session.shoot(route, variant, { a11y: true })).a11y?.violations).toHaveLength(
        2,
      );
    } finally {
      await session.close();
    }
  });

  test("works under paused timers and a strict script-src CSP", async () => {
    const { manifest } = await capture("/strict", true);
    expect(manifest.snapshots[0]?.a11y?.violations.map((v) => v.rule).toSorted()).toEqual([
      "color-contrast",
      "label",
    ]);
  });

  test("the scan does not change the screenshot", async () => {
    const on = await capture("/broken", true);
    const off = await capture("/broken", false);
    const read = async (c: typeof on) =>
      Buffer.from(await Bun.file(join(c.out, "page/desktop.png")).arrayBuffer());
    expect((await read(on)).equals(await read(off))).toBe(true);
  });
});

describe("new on Branch", { timeout: 120_000 }, () => {
  test("both violations are new on Branch when Main is clean", async () => {
    const main = await capture("/fixed", true);
    const branch = await capture("/broken", true);
    const diff = diffA11y(main.manifest.snapshots[0]?.a11y, branch.manifest.snapshots[0]?.a11y);
    expect(diff.state).toBe("compared");
    if (diff.state !== "compared") return;
    expect(diff.fresh.map((v) => v.rule).toSorted()).toEqual(["color-contrast", "label"]);
    expect(diff.already).toEqual([]);
  });

  test("nothing is new when Main has them too", async () => {
    const main = await capture("/broken", true);
    const branch = await capture("/broken", true);
    const diff = diffA11y(main.manifest.snapshots[0]?.a11y, branch.manifest.snapshots[0]?.a11y);
    if (diff.state !== "compared") throw new Error("expected a comparison");
    expect(diff.fresh).toEqual([]);
    expect(diff.already.map((v) => v.rule).toSorted()).toEqual(["color-contrast", "label"]);
  });

  test("only the one Main did not have is new", async () => {
    const main = await capture("/contrast-only", true);
    const branch = await capture("/broken", true);
    const diff = diffA11y(main.manifest.snapshots[0]?.a11y, branch.manifest.snapshots[0]?.a11y);
    if (diff.state !== "compared") throw new Error("expected a comparison");
    expect(diff.fresh.map((v) => v.rule)).toEqual(["label"]);
  });

  test("compare writes the accessibility section and says which are new", async () => {
    const main = await capture("/fixed", true);
    const branch = await capture("/broken", true);
    const out = join(root, "cmp");
    const r = await compareSnapshots({ mainDir: main.out, branchDir: branch.out, out });
    const row = [...r.changed, ...r.unchanged][0];
    expect(row?.a11y?.state).toBe("compared");
    const html = await Bun.file(r.indexPath).text();
    expect(html).toContain("Accessibility (1 scanned)");
    expect(html).toContain("New on Branch (2)");
  });

  test("a Branch scan with no Main scan calls nothing new", async () => {
    const main = await capture("/broken", undefined);
    const branch = await capture("/broken", true);
    const out = join(root, "cmp-unbaselined");
    const r = await compareSnapshots({ mainDir: main.out, branchDir: branch.out, out });
    const row = [...r.changed, ...r.unchanged][0];
    expect(row?.a11y?.state).toBe("unbaselined");
    expect(await Bun.file(r.indexPath).text()).toContain("none called new");
  });

  test("neither side scanned: the index has no accessibility section", async () => {
    const main = await capture("/broken", undefined);
    const branch = await capture("/broken", undefined);
    const out = join(root, "cmp-off");
    const r = await compareSnapshots({ mainDir: main.out, branchDir: branch.out, out });
    expect(await Bun.file(r.indexPath).text()).not.toContain("Accessibility");
  });
});
