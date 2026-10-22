import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Region } from "./regions.ts";

/**
 * `pixelslash dev`'s iterations and pins (ob 1740), in the worktree's `.pixelslash/dev/`. Each run
 * is a numbered dir holding its shots, the compare against its comparison point and `result.json`.
 * The files are the truth: a restart, a second process and the live page all read them back.
 */

export const DEV_DIR = join(".pixelslash", "dev");

/** Pruned past this, oldest first; pins and the latest iteration are kept whatever the size. */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export type DevStore = { root: string };

export type DevShot = {
  name: string;
  shot: string;
  status: "changed" | "unchanged" | "new" | "removed";
  changedPixels: number;
  regions: Region[];
  /** The variant it was shot in, and its pixel size (ob 1741); absent on iterations from before. */
  variant?: string | undefined;
  size?: { width: number; height: number } | undefined;
  /** Absolute paths: this run's shot, the one it was compared with, and the diff when it changed. */
  files: {
    shot?: string | undefined;
    against?: string | undefined;
    diff?: string | undefined;
    report?: string | undefined;
  };
};

export type JudgeNote = { name: string; shot: string; component: string; reason: string };

/** The design-system judge's verdict on an iteration: run, skipped (no judge) or failed. */
export type DevJudge =
  | { status: "done"; notes: JudgeNote[] }
  | { status: "skipped"; reason: string; notes: [] }
  | { status: "failed"; reason: string; notes: [] };

/** One thing the judge says differs from the spec or reference, boxed on the shot in its pixels. */
export type Difference = {
  /** 1-based, the number on its box. */
  n: number;
  name: string;
  shot: string;
  /** The reference it was told about (a path or Figma URL); null when it had the spec alone. */
  ref: string | null;
  area: { x: number; y: number; width: number; height: number };
  what: string;
};

/**
 * The judge's account of how the shots differ from the feature's spec and references (ob 1741).
 * A list of descriptions, never a verdict or a score.
 */
export type DevDifferences =
  | { status: "done"; items: Difference[] }
  | { status: "skipped"; reason: string; items: [] }
  | { status: "failed"; reason: string; items: [] };

/** What a run was compared with: the previous run, a pinned one, main's baselines, or nothing yet. */
export type DevAgainst = { kind: "previous" | "pin" | "main" | "none"; iteration: string | null };

export type DevIteration = {
  id: string;
  target: string;
  at: string;
  against: DevAgainst;
  /** Why the comparison is not the one asked for (e.g. `--against main` without credentials). */
  note: string | null;
  counts: { changed: number; unchanged: number; new: number; removed: number };
  regions: number;
  changedPixels: number;
  /** `settleMs` is the page's own load and settle; `oursMs` is everything else in the run. */
  timings: { oursMs: number; settleMs: number; totalMs: number };
  dir: string;
  /** The compare's `index.html`. */
  report: string;
  shots: DevShot[];
  judge: DevJudge | null;
  /** Set when `--judge` ran on a target with a spec or refs (ob 1741). */
  differences?: DevDifferences | null | undefined;
};

export function devStore(worktree: string): DevStore {
  return { root: join(worktree, DEV_DIR) };
}

const iterationsDir = (store: DevStore) => join(store.root, "iterations");
export const iterationDir = (store: DevStore, id: string) => join(iterationsDir(store), id);
const pinsFile = (store: DevStore) => join(store.root, "pins.json");
const ID = /^\d{6}$/;

/** Every iteration id, oldest first. */
export async function listIterations(store: DevStore): Promise<string[]> {
  try {
    return (await readdir(iterationsDir(store))).filter((n) => ID.test(n)).toSorted();
  } catch {
    return [];
  }
}

/** The next iteration's id and its (new, empty) dir. */
export async function newIteration(store: DevStore): Promise<{ id: string; dir: string }> {
  const ids = await listIterations(store);
  const id = String(Number(ids.at(-1) ?? "0") + 1).padStart(6, "0");
  const dir = iterationDir(store, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return { id, dir };
}

export async function saveIteration(it: DevIteration): Promise<void> {
  await Bun.write(join(it.dir, "result.json"), `${JSON.stringify(it, null, 2)}\n`);
}

/** An iteration's result, or undefined when it has none (still running, or pruned). */
export async function readIteration(
  store: DevStore,
  id: string,
): Promise<DevIteration | undefined> {
  const file = Bun.file(join(iterationDir(store, id), "result.json"));
  if (!(await file.exists())) return undefined;
  const value: unknown = await file.json();
  return isIteration(value) ? value : undefined;
}

function isIteration(v: unknown): v is DevIteration {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof Reflect.get(v, "id") === "string" &&
    typeof Reflect.get(v, "target") === "string" &&
    Array.isArray(Reflect.get(v, "shots"))
  );
}

/** The newest finished iteration, of `target` when one is named. */
export async function latestIteration(
  store: DevStore,
  target?: string,
): Promise<DevIteration | undefined> {
  for (const id of (await listIterations(store)).toReversed()) {
    const it = await readIteration(store, id);
    if (it && (target === undefined || it.target === target)) return it;
  }
  return undefined;
}

export async function readPins(store: DevStore): Promise<string[]> {
  const file = Bun.file(pinsFile(store));
  if (!(await file.exists())) return [];
  const value: unknown = await file.json();
  const pins: unknown = typeof value === "object" && value ? Reflect.get(value, "pins") : [];
  return Array.isArray(pins) ? pins.filter((p): p is string => typeof p === "string") : [];
}

async function writePins(store: DevStore, pins: string[]): Promise<void> {
  await mkdir(store.root, { recursive: true });
  await Bun.write(pinsFile(store), `${JSON.stringify({ pins }, null, 2)}\n`);
}

/** Pin `id` (default: the latest iteration) as the comparison point; returns the pinned id. */
export async function pinIteration(store: DevStore, id?: string): Promise<string | undefined> {
  const chosen = id ?? (await latestIteration(store))?.id;
  if (!chosen || !(await readIteration(store, chosen))) return undefined;
  const pins = (await readPins(store)).filter((p) => p !== chosen);
  await writePins(store, [...pins, chosen]);
  return chosen;
}

/** Unpin `id` (default: the newest pin); returns the unpinned id, undefined when nothing was. */
export async function unpinIteration(store: DevStore, id?: string): Promise<string | undefined> {
  const pins = await readPins(store);
  const chosen = id ?? pins.at(-1);
  if (!chosen || !pins.includes(chosen)) return undefined;
  await writePins(
    store,
    pins.filter((p) => p !== chosen),
  );
  return chosen;
}

/**
 * What the next run of `target` is compared with: the newest pin of that target, else the newest
 * iteration of it, else nothing (the first run).
 */
export async function comparisonPoint(store: DevStore, target: string): Promise<DevAgainst> {
  for (const id of (await readPins(store)).toReversed()) {
    if ((await readIteration(store, id))?.target === target) return { kind: "pin", iteration: id };
  }
  const previous = await latestIteration(store, target);
  return previous
    ? { kind: "previous", iteration: previous.id }
    : { kind: "none", iteration: null };
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

/**
 * Remove the oldest iterations until the store is under `maxBytes`. A pinned iteration, the newest
 * one and what the newest was compared with are never removed, so the live page keeps its shots.
 * Returns the removed ids.
 */
export async function pruneIterations(store: DevStore, maxBytes: number): Promise<string[]> {
  const ids = await listIterations(store);
  const newest = await latestIteration(store);
  const keep = new Set([...(await readPins(store)), ids.at(-1), newest?.against.iteration]);
  const sizes = new Map<string, number>();
  for (const id of ids) sizes.set(id, await sizeOf(iterationDir(store, id)));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0);
  const removed: string[] = [];
  for (const id of ids) {
    if (total <= maxBytes) break;
    if (keep.has(id)) continue;
    await rm(iterationDir(store, id), { recursive: true, force: true });
    total -= sizes.get(id) ?? 0;
    removed.push(id);
  }
  return removed;
}
