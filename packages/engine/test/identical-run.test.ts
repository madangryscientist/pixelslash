import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { identicalBytes } from "../src/identical.ts";
import { IDENTICAL_NOTE } from "../src/identical-note.ts";
import { renderPixelReport } from "../src/report.ts";
import { writeRunFiles } from "../src/run.ts";

/** A pair of the same bytes is not diffed, drawn or reported as a diff (ob 1948). */

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "ps-identical-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

function solid(rgb: [number, number, number]): Buffer {
  const img = new PNG({ width: 12, height: 10 });
  for (let i = 0; i < 12 * 10; i++) {
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(img);
}

describe("a run of identical bytes", () => {
  test("writes no diff image, and the manifest says how it was settled", async () => {
    const dest = await scratch();
    const png = solid([255, 255, 255]);
    const written = await writeRunFiles(dest, { main: png, branch: Buffer.from(png) });
    expect(written.manifest).toMatchObject({
      changed: false,
      changedPixels: 0,
      regions: [],
      settledBy: "identical-bytes",
    });
    expect(written.main).toEqual({ width: 12, height: 10 });
    expect(existsSync(join(dest, "diff.png"))).toBe(false);
    const stored = await Bun.file(join(dest, "manifest.json")).json();
    expect(stored.settledBy).toBe("identical-bytes");
  });

  test("a changed pair still writes its diff image and no settledBy", async () => {
    const dest = await scratch();
    const written = await writeRunFiles(dest, {
      main: solid([255, 255, 255]),
      branch: solid([255, 0, 0]),
    });
    expect(written.manifest.changed).toBe(true);
    expect(written.manifest.settledBy).toBeUndefined();
    expect(existsSync(join(dest, "diff.png"))).toBe(true);
  });

  test("a diff image left by an earlier run in the same directory is removed", async () => {
    const dest = await scratch();
    await writeRunFiles(dest, { main: solid([255, 255, 255]), branch: solid([255, 0, 0]) });
    expect(existsSync(join(dest, "diff.png"))).toBe(true);
    const png = solid([255, 255, 255]);
    await writeRunFiles(dest, { main: png, branch: Buffer.from(png) });
    expect(existsSync(join(dest, "diff.png"))).toBe(false);
  });

  test("a PNG header without an IHDR or with a zero size is not trusted", () => {
    const png = solid([0, 0, 0]);
    const noIhdr = Buffer.from(png);
    noIhdr.write("XXXX", 12, "latin1");
    const zero = Buffer.from(png);
    zero.writeUInt32BE(0, 16);
    expect(identicalBytes(noIhdr, Buffer.from(noIhdr))).toBeNull();
    expect(identicalBytes(zero, Buffer.from(zero))).toBeNull();
    expect(identicalBytes(png, Buffer.from(png))?.settledBy).toBe("identical-bytes");
  });

  test("the report says the bytes were the same and shows no diff", () => {
    const html = renderPixelReport({
      changedPixels: 0,
      changed: false,
      regions: [],
      specks: { count: 0, pixels: 0 },
      settledBy: "identical-bytes",
      main: { width: 12, height: 10 },
      branch: { width: 12, height: 10 },
    });
    expect(html).toContain(IDENTICAL_NOTE);
    expect(html).toContain('<img src="main.png" alt="Main">');
    expect(html).toContain('<img src="branch.png" alt="Branch">');
    expect(html).not.toContain("diff.png");
    expect(html).not.toContain("Full frame");
  });
});
