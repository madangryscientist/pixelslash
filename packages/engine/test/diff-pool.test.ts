import { afterAll, describe, expect, test } from "vitest";
import { PNG } from "pngjs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareSnapshots, type SnapshotCompareResult } from "../src/compare-snapshots.ts";
import { diffPngs } from "../src/diff.ts";
import { diffCores } from "../src/diff-cores.ts";
import {
  type DiffReply,
  type DiffRequest,
  type WorkerLike,
  pooledDiff,
  withDiffPool,
} from "../src/diff-pool.ts";
import { UsageError } from "../src/errors.ts";
import { timingsTable } from "../src/report-timings.ts";

/** `PIXELSLASH_DIFF_CORES`: how many local comparisons run at once, in a pool of Bun workers. */

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A 24x16 PNG, white, with a black square at `at` (none for -1). */
function png(at: number): Buffer {
  const img = new PNG({ width: 24, height: 16 });
  img.data.fill(255);
  const xs = at < 0 ? [] : [at, at + 1, at + 2, at + 3, at + 4, at + 5];
  for (let y = 4; y < 10; y++)
    for (const x of xs) img.data.fill(0, (y * 24 + x) * 4, (y * 24 + x) * 4 + 3);
  return PNG.sync.write(img);
}

function entry(name: string) {
  return {
    name,
    path: `/${name}`,
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 24, height: 16 },
      theme: "light",
    },
    tags: [],
    file: `${name}.png`,
    fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
  };
}

function writeManifest(dir: string, list: string[]) {
  const snapshots = list.map(entry);
  return Bun.write(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots }));
}

/**
 * Main and Branch over `count` shots: most changed, every fifth the same bytes, every seventh cut
 * short, not a whole PNG, on Branch (the diff throws), one only on Main and one only on Branch.
 */
async function pairDirs(count: number): Promise<{ main: string; branch: string }> {
  const main = await tmp("pixelslash-pool-main-");
  const branch = await tmp("pixelslash-pool-branch-");
  const names = Array.from({ length: count }, (_, i) => `shot-${i}`);
  for (const [i, name] of names.entries()) {
    await Bun.write(join(main, `${name}.png`), png(-1));
    let side = png(i % 18);
    if (i % 5 === 0) side = png(-1);
    if (i % 7 === 3) side = png(-1).subarray(0, 40);
    await Bun.write(join(branch, `${name}.png`), side);
  }
  await Bun.write(join(main, "gone.png"), png(-1));
  await Bun.write(join(branch, "new.png"), png(2));
  await writeManifest(main, [...names, "gone"]);
  await writeManifest(branch, ["new", ...names]);
  return { main, branch };
}

/** Every file under `dir`, by path, with `index.html`'s timings table (wall-clock time) taken out. */
async function filesOf(dir: string, result: SnapshotCompareResult): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const rel of (await readdir(dir, { recursive: true })).toSorted()) {
    const file = Bun.file(join(dir, rel));
    if (!(await file.exists())) continue;
    const bytes = Buffer.from(await file.arrayBuffer()).toString("base64");
    files.set(rel, bytes);
  }
  const index = await Bun.file(result.indexPath).text();
  files.set("index.html", index.replace(`${timingsTable(result.timings)}\n`, ""));
  return files;
}

/** The rows of a result, without the timings. */
function rowsOf(r: SnapshotCompareResult) {
  const { timings: _, indexPath: __, ...rows } = r;
  return rows;
}

/**
 * A worker that diffs on the main thread after a tick and counts how many jobs are in flight, how
 * many workers were made and how many were terminated.
 */
/** What the real worker answers, made on this thread. */
function reply(req: DiffRequest): DiffReply {
  try {
    const main = Buffer.from(req.main);
    const { overlay, ...rest } = diffPngs(main, Buffer.from(req.branch), req.options, req.ignore);
    return { id: req.id, ok: true, result: { ...rest, overlay } };
  } catch (e) {
    return { id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function countingWorkers(fail?: (req: DiffRequest) => boolean) {
  const seen = { inFlight: 0, most: 0, jobs: 0, spawned: 0, terminated: 0 };
  const spawn = (): WorkerLike => {
    seen.spawned++;
    let dead = false;
    const listeners: {
      message?: (e: MessageEvent<DiffReply>) => void;
      error?: (e: ErrorEvent) => void;
    } = {};
    const w: WorkerLike = {
      addEventListener(type: "message" | "error", listener: never) {
        listeners[type] = listener;
      },
      postMessage(req) {
        seen.inFlight++;
        seen.jobs++;
        seen.most = Math.max(seen.most, seen.inFlight);
        setTimeout(() => {
          seen.inFlight--;
          if (dead) return;
          if (fail?.(req)) {
            listeners.error?.(new ErrorEvent("error", { message: "worker died" }));
            return;
          }
          listeners.message?.(new MessageEvent("message", { data: reply(req) }));
        }, 2);
      },
      terminate() {
        if (!dead) seen.terminated++;
        dead = true;
      },
    };
    return w;
  };
  return { seen, spawn };
}

const fallback = () => 3;

describe("PIXELSLASH_DIFF_CORES", () => {
  test("a whole number from 1 to 32 is used as given", () => {
    for (const v of ["1", "4", "32"])
      expect(diffCores({ PIXELSLASH_DIFF_CORES: v }, fallback)).toBe(Number(v));
  });

  test("unset or empty takes capture's default", () => {
    expect(diffCores({}, fallback)).toBe(3);
    expect(diffCores({ PIXELSLASH_DIFF_CORES: "" }, fallback)).toBe(3);
  });

  test.each(["0", "33", "abc", "4.5", "-1", " 4", "1e1"])(
    "%j is a usage error naming the variable and the range",
    (v) => {
      expect(() => diffCores({ PIXELSLASH_DIFF_CORES: v }, fallback)).toThrow(UsageError);
      expect(() => diffCores({ PIXELSLASH_DIFF_CORES: v }, fallback)).toThrow(
        `PIXELSLASH_DIFF_CORES must be a whole number from 1 to 32 (got "${v}")`,
      );
    },
  );
});

describe("the diff pool", () => {
  test("4 cores never has more than 4 comparisons in flight, over many shots", async () => {
    const { main, branch } = await pairDirs(40);
    const { seen, spawn } = countingWorkers();
    const out = await tmp("pixelslash-pool-out-");
    await withDiffPool(() => compareSnapshots({ mainDir: main, branchDir: branch, out }), {
      cores: 4,
      spawn,
    });
    expect(seen.jobs).toBe(40);
    expect(seen.most).toBe(4);
    expect(seen.spawned).toBe(4);
    expect(seen.terminated).toBe(4);
  });

  test("1 core and 4 real workers give the same rows, files and report", async () => {
    const { main, branch } = await pairDirs(30);
    const one = await tmp("pixelslash-pool-one-");
    const four = await tmp("pixelslash-pool-four-");
    const serial = await withDiffPool(
      () => compareSnapshots({ mainDir: main, branchDir: branch, out: one }),
      { cores: 1 },
    );
    const pooled = await withDiffPool(
      () => compareSnapshots({ mainDir: main, branchDir: branch, out: four }),
      { cores: 4 },
    );
    expect(serial.changed.length).toBeGreaterThan(10);
    expect(serial.unchanged.length).toBeGreaterThan(3);
    // A shot the worker threw on is the same `failed` row a serial throw gives.
    expect(serial.failed.length).toBe(4);
    expect(serial.failed[0]?.error).toBeTruthy();
    expect(rowsOf(pooled)).toEqual(rowsOf(serial));
    expect(await filesOf(four, pooled)).toEqual(await filesOf(one, serial));
  });

  test("the overlay of a real worker is the bytes the main thread draws", async () => {
    const serial = diffPngs(png(-1), png(3));
    const pooled = await withDiffPool(() => pooledDiff(png(-1), png(3)), { cores: 2 });
    expect(pooled).toEqual(serial);
    expect(Buffer.isBuffer(pooled.overlay)).toBe(true);
  });

  test("no worker outlives a run that throws", async () => {
    const { seen, spawn } = countingWorkers();
    const run = withDiffPool(
      async () => {
        await Promise.all([pooledDiff(png(-1), png(1)), pooledDiff(png(-1), png(2))]);
        throw new Error("the run failed");
      },
      { cores: 4, spawn },
    );
    await expect(run).rejects.toThrow("the run failed");
    expect(seen.spawned).toBe(2);
    expect(seen.terminated).toBe(2);
  });

  test("a worker that dies fails its own job only, and the next job gets a fresh worker", async () => {
    let first = true;
    const { seen, spawn } = countingWorkers(() => {
      const die = first;
      first = false;
      return die;
    });
    await withDiffPool(
      async () => {
        await expect(pooledDiff(png(-1), png(1))).rejects.toThrow("worker died");
        const diff = await pooledDiff(png(-1), png(2));
        expect(diff.changed).toBe(true);
      },
      { cores: 2, spawn },
    );
    expect(seen.spawned).toBe(2);
    expect(seen.terminated).toBe(2);
  });

  test("1 core starts no worker", async () => {
    const { seen, spawn } = countingWorkers();
    const diff = await withDiffPool(() => pooledDiff(png(-1), png(1)), { cores: 1, spawn });
    expect(diff).toEqual(diffPngs(png(-1), png(1)));
    expect(seen.spawned).toBe(0);
  });
});
