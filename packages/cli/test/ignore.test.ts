import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { DS, capture, cleanup, faintPair, readManifest, tmp } from "./support.ts";

afterAll(cleanup);

describe("--ignore", () => {
  test("a change inside the box is skipped, counted and hatched in the report", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const code = await run(
      ["--live-png", live, "--local-png", local, "--out", dir, "--ignore", "0,0,20,20"],
      cap.io,
      {},
    );
    expect(code).toBe(0);
    expect(cap.stdout).toContain("0 changed pixels");
    expect(await readManifest(join(dir, "manifest.json"))).toMatchObject({
      changedPixels: 0,
      ignoredPixels: 400,
      ignored: [{ x: 0, y: 0, width: 20, height: 20 }],
    });
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("400 ignored pixels in 1 area (hatched)");
    expect(html).toContain('class="ignore"');
  });

  test("repeats; a box half over the change leaves the rest counted", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    await run(
      [
        "--live-png",
        live,
        "--local-png",
        local,
        "--out",
        dir,
        "--ignore",
        "0,0,10,20",
        "--ignore",
        "10,0,5,20",
      ],
      cap.io,
      {},
    );
    expect(cap.stdout).toContain("100 changed pixels");
    expect(await readManifest(join(dir, "manifest.json"))).toMatchObject({
      changedPixels: 100,
      ignoredPixels: 300,
    });
  });

  test("a run without --ignore reports no ignored pixels", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    await run(["--live-png", live, "--local-png", local, "--out", dir], capture().io, {});
    expect(await readManifest(join(dir, "manifest.json"))).toMatchObject({ ignoredPixels: 0 });
    expect(await Bun.file(join(dir, "report.html")).text()).not.toContain("ignored pixel");
  });

  test.each([
    [["--ignore", "1,2,3"], /--ignore must be x,y,w,h/],
    [["--ignore", "a,b,c,d"], /--ignore must be x,y,w,h/],
    [["--ignore", "0,0,0,5"], /--ignore must be x,y,w,h/],
    [["--ignore", "-1,0,5,5"], /--ignore must be x,y,w,h/],
    [["--ignore", "0,0,1.5,5"], /--ignore must be x,y,w,h/],
    [["--ignore"], /missing value for --ignore/],
    [["--ignore", "--out"], /missing value for --ignore/],
  ])("%j exits 2", async (flags, message) => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, ...flags], cap.io, {});
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(message);
  });

  test("with --routes it exits 2: the boxes belong to one pair", async () => {
    const dir = await tmp();
    const cap = capture();
    const code = await run(
      [
        "--live-png-dir",
        dir,
        "--local-png-dir",
        dir,
        "--routes",
        join(dir, "r.json"),
        "--ds",
        DS,
        "--ignore",
        "0,0,5,5",
      ],
      cap.io,
      {},
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/--ignore applies to a single pair, not --routes/);
  });
});
