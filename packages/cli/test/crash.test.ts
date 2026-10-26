import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, faintPair, solidPng, tmp } from "./support.ts";
import { gitRepo, snapshotDir as uploadDir } from "./upload-support.ts";

// The engine's `diffPngs`, made to throw on chosen calls: a crash in the diff, injected.
const boom = vi.hoisted(() => ({ calls: 0, on: (_n: number): boolean => false }));
vi.mock(import("../../engine/src/diff.ts"), async (original) => {
  const real = await original();
  return {
    ...real,
    diffPngs: (...args: Parameters<typeof real.diffPngs>) => {
      boom.calls++;
      if (boom.on(boom.calls)) throw new Error("diff blew up");
      return real.diffPngs(...args);
    },
  };
});

beforeEach(() => {
  boom.calls = 0;
  boom.on = () => false;
});
afterAll(cleanup);

/** A snapshot dir as `pixelslash capture` writes it: one solid 40x40 shot per name. */
async function snapshotDir(shots: Record<string, number>): Promise<string> {
  const dir = await tmp();
  const snapshots = [];
  for (const [name, grey] of Object.entries(shots)) {
    await Bun.write(join(dir, `${name}.png`), solidPng(40, 40, [grey, grey, grey, 255]));
    snapshots.push({
      name,
      path: `/${name}`,
      variant: {
        name: "light",
        browser: "chromium",
        viewport: { width: 40, height: 40 },
        theme: "light",
      },
      tags: [],
      diff: {},
      ignore: [],
      file: `${name}.png`,
      fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:a" },
    });
  }
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots }));
  return dir;
}

describe("a crashed run fails loudly (PS-223)", () => {
  test("a throwing diff in the pixel run is exit 7 and one FAILED line, never exit 1", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    boom.on = () => true;
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {});
    expect(code).toBe(7);
    const lines = cap.stderr.split("\n");
    expect(lines[0]).toBe("pixelslash: FAILED compare: compare: diff blew up");
    expect(lines[1]).toBe("nothing was uploaded");
    expect(lines[2]).toContain("escalate to the PixelSlash planner");
    expect(cap.stderr).toContain("at "); // the stack follows
    expect(cap.stdout).not.toContain("report:");
  });

  test("one shot the diff cannot measure is `not compared`: the rest is reported, exit 7 names it", async () => {
    const main = await snapshotDir({ a: 100, b: 100, c: 100 });
    const branch = await snapshotDir({ a: 220, b: 220, c: 100 });
    const out = await tmp();
    boom.on = (n) => n === 2; // the second shot, `b`
    const cap = capture();
    const code = await run(["compare", main, branch, "--out", out], cap.io, {});
    expect(code).toBe(7);
    expect(cap.stdout).toContain("1 changed, 1 unchanged, 0 new, 0 removed, 1 not compared");
    expect(cap.stdout).toMatch(/not compared: b .*: diff blew up/);
    expect(cap.stdout).toContain(`report: file://${join(out, "index.html")}`);
    expect(cap.stderr).toMatch(/^pixelslash: FAILED compare: compare: 1 shot not compared: b /m);

    const index = await Bun.file(join(out, "index.html")).text();
    expect(index).toContain("1 not compared");
    expect(index).toContain("Not compared");
    expect(index).toContain("diff blew up");
    // `b` is not claimed unchanged, and its sibling `a` is still reported as changed.
    expect(index).toContain('href="a/chromium-40x40-light/report.html"');
    expect(index).not.toContain('href="b/');
  });

  test("a PNG with a valid header the decoder cannot read is `not compared` with the real diff", async () => {
    const main = await snapshotDir({ a: 100 });
    const branch = await snapshotDir({ a: 100 });
    // The manifest check reads the header only, so this reaches the diff and fails there.
    await Bun.write(
      join(branch, "a.png"),
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0),
    );
    const cap = capture();
    const code = await run(["compare", main, branch, "--out", await tmp()], cap.io, {});
    expect(code).toBe(7);
    expect(cap.stdout).toMatch(/not compared: a /);
    expect(cap.stderr).toMatch(/^pixelslash: FAILED compare: compare: 1 shot not compared: a /m);
  });
});

const SERVER = "https://ps.example";
const refused = async () => Response.json({ error: "no" }, { status: 401 });
const putFails = async (_url: string, init?: RequestInit) =>
  (init?.method ?? "GET") === "PUT"
    ? Response.json({ error: "disk" }, { status: 500 })
    : Response.json({ id: "build-1", status: "passed" });

describe("an upload failure ends on UPLOAD FAILED (PS-223)", () => {
  test("a refusal before anything is sent: nothing was uploaded, no link", async () => {
    const [cwd, dir, cap] = [await gitRepo(), await uploadDir(), capture()];
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: refused,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_revoked" },
    });
    expect(code).toBe(1);
    const lines = cap.stderr.trimEnd().split("\n");
    expect(lines.at(-2)).toBe("nothing was uploaded");
    expect(lines.at(-1)).toMatch(/UPLOAD FAILED: .*401/);
    expect(cap.stdout).not.toMatch(/build:|https?:\/\//);
  });

  test("a failure mid-way says how many shots were sent", async () => {
    const [cwd, dir, cap] = [await gitRepo(), await uploadDir(), capture()];
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: putFails,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_env" },
    });
    expect(code).toBe(1);
    const lines = cap.stderr.trimEnd().split("\n");
    expect(lines.at(-2)).toBe("upload incomplete: 0/1 shots sent");
    expect(lines.at(-1)).toMatch(/UPLOAD FAILED: .*500/);
    expect(cap.stdout).not.toMatch(/build:|https?:\/\//);
  });

  test("a build the server errored fails the upload and never exits 0 (PS-228)", async () => {
    const [cwd, dir, cap] = [await gitRepo(), await uploadDir(), capture()];
    const errored = async () =>
      Response.json({
        id: "build-1",
        status: "errored",
        error: "database is locked",
        unmeasured: 0,
        web_url: `${SERVER}/projects/p1/builds/build-1`,
      });
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: errored,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_env" },
    });
    expect(code).toBe(1);
    const lines = cap.stderr.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(
      `UPLOAD FAILED: build build-1 errored on the server: database is locked (${SERVER}/projects/p1/builds/build-1)`,
    );
    expect(cap.stdout).not.toMatch(/build:/);
  });
});
