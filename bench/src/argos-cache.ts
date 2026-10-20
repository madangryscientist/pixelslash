/**
 * Argos's verdicts, kept in the repo (ob 1488) so `bun run bench` makes the whole comparison
 * without VM 101. An entry is keyed by the pair's content hash, the Argos commit and the
 * threshold, so a changed pair, a rebuilt image or a new threshold is a miss, never a stale hit.
 * The VM is needed only to fill misses (`--refresh-argos`).
 *
 * `bench/argos-cache.json` holds the verdict, score, time and changed regions of each pair;
 * `bench/argos-cache/diffs/` holds the diff images the disagreement page shows. The pairs
 * themselves are ours (bench/corpus*); nothing of Argos's is stored but its answers about them.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argosHost, argosNote, liveArgosCommit, runArgos } from "./argos.ts";
import { BENCH_DIR, caseKey, isRecord, type CorpusCase } from "./corpus.ts";
import type { Rect } from "./regions.ts";
import { say } from "./say.ts";
import type { ToolResult } from "./types.ts";

/** `diffImages`'s own default, and the one the wrapper uses unless told otherwise. */
export const ARGOS_THRESHOLD = 0.5;

export const CACHE_FILE = join(BENCH_DIR, "argos-cache.json");
export const CACHE_DIFFS = join(BENCH_DIR, "argos-cache", "diffs");
const DOCKERFILE = join(BENCH_DIR, "..", "ops", "argos-bench", "Dockerfile");

export type CacheEntry = {
  /** `<corpus>/<case>` when the entry was written; a hint for people, never part of the lookup. */
  label: string;
  changed: boolean;
  score: number;
  ms: number | null;
  regions: Rect[];
  /** Whether Argos made a diff image, kept as `diffs/<hash>.png`. */
  diff: boolean;
};

export type ArgosCache = { version: 1; entries: Record<string, CacheEntry> };

/** The commit the image is pinned to, from the Dockerfile: what the cache is keyed on without a VM. */
export function pinnedArgosCommit(dockerfile = readFileSync(DOCKERFILE, "utf8")): string {
  const m = /^ARG ARGOS_COMMIT=([0-9a-f]{40})$/m.exec(dockerfile);
  if (!m?.[1]) throw new Error(`no ARG ARGOS_COMMIT in ${DOCKERFILE}`);
  return m[1];
}

/** Content hash of a pair: the bytes of both shots, each length-prefixed so they cannot blur. */
export function pairHash(base: Buffer, head: Buffer): string {
  const h = createHash("sha256");
  for (const bytes of [base, head]) {
    h.update(`${bytes.length}:`);
    h.update(bytes);
  }
  return h.digest("hex");
}

export const cacheKey = (hash: string, commit: string, threshold: number): string =>
  `${hash}:${commit}:${threshold}`;

const diffName = (hash: string) => `${hash.slice(0, 24)}.png`;

function parseRect(raw: unknown): Rect {
  if (!isRecord(raw)) throw new Error("bad region in argos-cache.json");
  const { x, y, w, h } = raw;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  )
    throw new Error("bad region in argos-cache.json");
  return { x, y, w, h };
}

function parseEntry(raw: unknown): CacheEntry {
  if (!isRecord(raw)) throw new Error("bad entry in argos-cache.json");
  const { label, changed, score, ms, regions, diff } = raw;
  if (
    typeof label !== "string" ||
    typeof changed !== "boolean" ||
    typeof score !== "number" ||
    !Array.isArray(regions) ||
    typeof diff !== "boolean"
  )
    throw new Error("bad entry in argos-cache.json");
  return {
    label,
    changed,
    score,
    ms: typeof ms === "number" ? ms : null,
    regions: regions.map(parseRect),
    diff,
  };
}

export function parseCache(text: string): ArgosCache {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw["version"] !== 1 || !isRecord(raw["entries"]))
    throw new Error("argos-cache.json is not a version 1 cache");
  const entries: Record<string, CacheEntry> = {};
  for (const [key, entry] of Object.entries(raw["entries"])) entries[key] = parseEntry(entry);
  return { version: 1, entries };
}

export function loadCache(file = CACHE_FILE): ArgosCache {
  return existsSync(file) ? parseCache(readFileSync(file, "utf8")) : { version: 1, entries: {} };
}

/** Sorted keys, so a refresh changes only the lines that changed. */
export function cacheText(cache: ArgosCache): string {
  const entries = Object.fromEntries(
    Object.entries(cache.entries).toSorted(([a], [b]) => (a < b ? -1 : 1)),
  );
  return `${JSON.stringify({ version: 1, entries }, null, 1)}\n`;
}

/** The cached answer for an entry, as the live run would have returned it. */
export function entryResult(key: string, entry: CacheEntry, diffsDir = CACHE_DIFFS): ToolResult {
  const hash = key.slice(0, key.indexOf(":"));
  const file = join(diffsDir, diffName(hash));
  if (entry.diff && !existsSync(file)) {
    throw new Error(
      `bench/argos-cache.json says Argos drew a diff for ${entry.label}, but ${file} is missing; delete the entry and run --refresh-argos`,
    );
  }
  return {
    changed: entry.changed,
    regions: entry.regions,
    ms: entry.ms,
    note: argosNote(entry.score),
    diffPng: entry.diff ? readFileSync(file) : null,
    sizeMismatch: false,
  };
}

const hashOf = (c: CorpusCase): string =>
  pairHash(readFileSync(join(c.dir, "base.png")), readFileSync(join(c.dir, "head.png")));

export type ArgosVerdicts = {
  results: Map<string, ToolResult>;
  commit: string;
  /** How many pairs the VM was asked about in this run. */
  refreshed: number;
};

/** Stage the pairs the VM has not seen, one directory per distinct content hash. */
function stage(dir: string, misses: Map<string, CorpusCase>): void {
  for (const [hash, c] of misses) {
    mkdirSync(join(dir, hash), { recursive: true });
    copyFileSync(join(c.dir, "base.png"), join(dir, hash, "base.png"));
    copyFileSync(join(c.dir, "head.png"), join(dir, hash, "head.png"));
  }
}

async function fill(
  cache: ArgosCache,
  misses: Map<string, CorpusCase>,
  commit: string,
): Promise<void> {
  const live = await liveArgosCommit();
  if (live === null) {
    throw new Error(
      `${misses.size} pair(s) need Argos and the VM at ${argosHost()} does not answer. Start it (\`ssh root@192.168.0.20 'qm start 101'\`, ops/argos-bench/runbook.md) and run again.`,
    );
  }
  if (live !== commit) {
    throw new Error(
      `the VM's image is Argos ${live}, but ops/argos-bench/Dockerfile pins ${commit}: rebuild the image (runbook step 3) or the cache would mix two Argos versions.`,
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), "pixelslash-argos-"));
  try {
    stage(join(scratch, "pairs"), misses);
    say(`argos: sending ${misses.size} new pair(s) to ${argosHost()}`);
    const { results } = await runArgos(
      join(scratch, "pairs"),
      join(scratch, "out"),
      ARGOS_THRESHOLD,
    );
    mkdirSync(CACHE_DIFFS, { recursive: true });
    for (const [hash, c] of misses) {
      const r = results.get(hash);
      if (!r) throw new Error(`Argos returned no verdict for ${caseKey(c)}`);
      cache.entries[cacheKey(hash, commit, ARGOS_THRESHOLD)] = {
        label: caseKey(c),
        changed: r.changed,
        score: r.score,
        ms: r.ms,
        regions: r.regions,
        diff: r.diffPng !== null,
      };
      if (r.diffPng) writeFileSync(join(CACHE_DIFFS, diffName(hash)), r.diffPng);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Drop what no case asks for any more, so the cache does not grow with every re-render. */
function prune(cache: ArgosCache, wanted: Set<string>): void {
  for (const key of Object.keys(cache.entries)) if (!wanted.has(key)) delete cache.entries[key];
  if (!existsSync(CACHE_DIFFS)) return;
  const keep = new Set(
    Object.entries(cache.entries)
      .filter(([, e]) => e.diff)
      .map(([key]) => diffName(key.slice(0, key.indexOf(":")))),
  );
  for (const f of readdirSync(CACHE_DIFFS)) if (!keep.has(f)) rmSync(join(CACHE_DIFFS, f));
}

/**
 * Argos's verdict for every case, from the cache. A case the cache has no answer for is an error
 * unless `refresh` is set, which asks the VM for the missing ones only and rewrites the cache.
 */
export async function argosVerdicts(cases: CorpusCase[], refresh: boolean): Promise<ArgosVerdicts> {
  const commit = pinnedArgosCommit();
  const cache = loadCache();
  const keys = new Map(
    cases.map((c) => {
      const hash = hashOf(c);
      return [caseKey(c), { hash, key: cacheKey(hash, commit, ARGOS_THRESHOLD), c }] as const;
    }),
  );
  const misses = new Map<string, CorpusCase>();
  for (const { hash, key, c } of keys.values()) if (!cache.entries[key]) misses.set(hash, c);
  if (misses.size > 0 && !refresh) {
    const names = [...misses.values()].map(caseKey);
    throw new Error(
      `bench/argos-cache.json has no Argos verdict for ${names.length} case(s): ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""}.\nRun \`bun run bench -- --refresh-argos\` with VM 101 up to fill them, or \`--no-argos\` to leave Argos out.`,
    );
  }
  if (refresh) {
    if (misses.size > 0) await fill(cache, misses, commit);
    prune(cache, new Set([...keys.values()].map((k) => k.key)));
    writeFileSync(CACHE_FILE, cacheText(cache));
  }
  const results = new Map<string, ToolResult>();
  for (const [name, { key }] of keys) {
    const entry = cache.entries[key];
    if (!entry) throw new Error(`no cached verdict for ${name}`);
    results.set(name, entryResult(key, entry));
  }
  return { results, commit, refreshed: misses.size };
}
