import type { SnapshotKey } from "#/db/baselines";
import type { NewBuild, SnapshotInput } from "#/db/builds";
import type { FlakeInput } from "#/db/flakes";
import {
  type DiffOptions,
  type DiffRegion,
  FLAKY_POLICIES,
  type FlakyPolicy,
  type IgnoreRect,
  type RegionKind,
} from "#/db/schema";

/** A request the client got wrong: surfaces as a 400 with this message. */
export class BadRequest extends Error {}

/** The actor may reach the row but not do this to it (a CI token resolving a flake): a 403. */
export class Forbidden extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bad(where: string, what: string): never {
  throw new BadRequest(`${where} ${what}`);
}

function text(v: unknown, where: string, max: number, pattern?: RegExp): string {
  if (typeof v !== "string" || v === "" || v.length > max)
    bad(where, `must be a non-empty string of at most ${max} characters`);
  if (pattern && !pattern.test(v)) bad(where, "has characters it may not use");
  return v;
}

/** A project's name as the web app takes it: trimmed, 1 to 100 characters. */
export function projectName(v: unknown): string {
  return text(typeof v === "string" ? v.trim() : v, "name", 100);
}

/** A git object id: SHA-1 (40) or SHA-256 (64) hex. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TOKEN = /^[\w.-]+$/;
export const MAX_ANCESTORS = 20;
const MAX_TAGS = 50;
const MAX_IGNORE = 200;

function sha(v: unknown, where: string): string {
  if (typeof v !== "string" || !SHA.test(v)) bad(where, "must be a lowercase hex git SHA");
  return v;
}

export function object(v: unknown, where: string): Obj {
  if (!isObj(v)) bad(where, "must be an object");
  return v;
}

export function parseNewBuild(raw: unknown): NewBuild {
  const b = object(raw, "body");
  const ancestors = b.ancestorShas ?? [];
  if (!Array.isArray(ancestors) || ancestors.length > MAX_ANCESTORS)
    bad("ancestorShas", `must be an array of at most ${MAX_ANCESTORS} SHAs`);
  const pr = b.prNumber ?? null;
  if (pr !== null && (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0))
    bad("prNumber", "must be a positive integer");
  return {
    commitSha: sha(b.commitSha, "commitSha"),
    branch: text(b.branch, "branch", 255),
    mergeBaseSha: b.mergeBaseSha == null ? null : sha(b.mergeBaseSha, "mergeBaseSha"),
    ancestorShas: ancestors.map((s, i) => sha(s, `ancestorShas[${i}]`)),
    prNumber: pr,
  };
}

/** The engine's `DiffOptions` keys and what each takes: a 0 to 1 share, or a count. A key not listed is refused. */
const DIFF_KINDS: Record<keyof DiffOptions, "share" | "count"> = {
  threshold: "share",
  minChangedPixels: "count",
  minChangedRatio: "share",
  mergeDistance: "count",
  minRegionArea: "count",
  noiseAmplitude: "share",
  maxShift: "share",
};

export function isDiffKey(k: string): k is keyof DiffOptions {
  return Object.hasOwn(DIFF_KINDS, k);
}

function diffValue(key: keyof DiffOptions, value: unknown): number {
  const where = `diff.${key}`;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    bad(where, "must be a non-negative number");
  if (DIFF_KINDS[key] === "count" && !Number.isInteger(value)) bad(where, "must be an integer");
  if (DIFF_KINDS[key] === "share" && value > 1) bad(where, "must be a number from 0 to 1");
  return value;
}

/** Absent is `{}`: older clients send no `diff`. */
export function parseDiff(v: unknown): DiffOptions {
  if (v === undefined) return {};
  const out: DiffOptions = {};
  for (const [key, value] of Object.entries(object(v, "diff"))) {
    if (!isDiffKey(key)) bad(`diff.${key}`, "is not a diff option");
    out[key] = diffValue(key, value);
  }
  return out;
}

function coord(v: unknown, where: string, min: 0 | 1): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
    bad(where, `must be ${min === 0 ? "a non-negative" : "a positive"} integer`);
  return v;
}

/** Image-px rectangles the diff skips. Absent is `[]`: older clients send no `ignore`. */
function parseIgnore(v: unknown): IgnoreRect[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_IGNORE)
    bad("ignore", `must be an array of at most ${MAX_IGNORE} { x, y, width, height }`);
  return v.map((r, i) => parseRect(r, `ignore[${i}]`));
}

/** One image-px rectangle `{ x, y, width, height }`: an ignore area, or a detection flag's (ob 1721). */
export function parseRect(v: unknown, where: string): IgnoreRect {
  const rect = object(v, where);
  return {
    x: coord(rect.x, `${where}.x`, 0),
    y: coord(rect.y, `${where}.y`, 0),
    width: coord(rect.width, `${where}.width`, 1),
    height: coord(rect.height, `${where}.height`, 1),
  };
}

/** A snapshot's identity: its name and the fixed variant. `at` prefixes each field's name in an error. */
export function parseSnapshotKey(raw: unknown, at = ""): SnapshotKey {
  const m = object(raw, at || "meta");
  const theme = m.theme;
  if (theme !== "light" && theme !== "dark") bad(`${at}theme`, 'must be "light" or "dark"');
  return {
    name: text(m.name, `${at}name`, 200),
    platform: text(m.platform, `${at}platform`, 40, TOKEN),
    browser: text(m.browser, `${at}browser`, 40, TOKEN),
    viewport: text(m.viewport, `${at}viewport`, 11, /^\d{1,5}x\d{1,5}$/),
    theme,
  };
}

/** The longest change note kept; a longer one is cut, not refused. */
const MAX_CHANGE_NOTE = 300;

/**
 * The judge's sentence for a changed shot (ob 1745). It is only ever shown, so a malformed one is
 * dropped, never a 400: one sentence, the line breaks folded, without its full stop (the pages
 * add one), cut to MAX_CHANGE_NOTE.
 */
function changeNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const note = v.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  return note === "" ? null : note.slice(0, MAX_CHANGE_NOTE);
}

export function parseSnapshotInput(raw: unknown): SnapshotInput {
  const m = object(raw, "meta");
  const tags = m.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS)
    bad("tags", `must be an array of at most ${MAX_TAGS} strings`);
  const fp = object(m.fingerprint, "fingerprint");
  return {
    ...parseSnapshotKey(m),
    tags: tags.map((t, i) => text(t, `tags[${i}]`, 100)),
    diff: parseDiff(m.diff),
    ignore: parseIgnore(m.ignore),
    fingerprint: {
      image: text(fp.image, "fingerprint.image", 300),
      browser: text(fp.browser, "fingerprint.browser", 300),
      fonts: text(fp.fonts, "fingerprint.fonts", 300),
    },
    changeNote: changeNote(m.changeNote),
  };
}

export function parseFinalise(raw: unknown): number {
  const n = object(raw, "body").snapshots;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
    bad("snapshots", "must be a non-negative integer");
  return n;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
  return head.length === 8 && PNG_SIGNATURE.every((b, i) => head[i] === b);
}

/** The width and height in a PNG's IHDR chunk (bytes 16 to 23, big-endian); the caller checked `isPng`. */
export function pngSize(bytes: ArrayBuffer): { width: number; height: number } {
  if (bytes.byteLength < 24) bad("file", "is too short to be a PNG");
  const view = new DataView(bytes);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) bad("file", "is a PNG with no pixels");
  return { width, height };
}

/** One baseline a CI run measured the shot against, as sent; finalise checks the result itself. */
export type CiResultInput = { baselineId: string; status: unknown; diffResult: unknown };
export type CiInput = { engineVersion: string; results: CiResultInput[] };

/** The shot and, when the pick carries, the accepted one it carries from (ob 1712). */
const MAX_CI_RESULTS = 2;
const ID = /^[\w-]{1,64}$/;

/**
 * `meta.ci`, what a CLI in a `ci` project sends with a shot (ob 1727): the engine version and one
 * result per baseline it measured against. Only the envelope is checked here; a result that is
 * not a result ends its shot errored at finalise, named, rather than failing the upload.
 */
export function parseCiInput(raw: unknown): CiInput | null {
  if (raw === undefined || raw === null) return null;
  const c = object(raw, "ci");
  if (!Array.isArray(c.results) || c.results.length === 0 || c.results.length > MAX_CI_RESULTS)
    bad("ci.results", `must be an array of 1 to ${MAX_CI_RESULTS} results`);
  const results = c.results.map((r, i) => {
    const o = object(r, `ci.results[${i}]`);
    return {
      baselineId: text(o.baselineId, `ci.results[${i}].baselineId`, 64, ID),
      status: o.status,
      diffResult: o.diffResult,
    };
  });
  if (new Set(results.map((r) => r.baselineId)).size !== results.length)
    bad("ci.results", "names a baseline twice");
  return { engineVersion: text(c.engineVersion, "ci.engineVersion", 64, TOKEN), results };
}

/** The most captures a flake record may name, the first included; a record over it is dropped. */
export const MAX_FLAKE_RUNS = 10;
const MAX_FLAKE_REGIONS = 200;
const REGION_KINDS: readonly RegionKind[] = ["change", "noise", "shift"];

function isFlakyPolicy(v: unknown): v is FlakyPolicy {
  return FLAKY_POLICIES.some((p) => p === v);
}

/**
 * `meta.flaky`, the policy the shot's config gives it (ob 1724). Anything that is not a policy is
 * no policy, never an error: the CLI sends it for every shot, and an older one sends none.
 */
export function parseFlaky(raw: unknown): FlakyPolicy | null {
  return isFlakyPolicy(raw) ? raw : null;
}

function int(v: unknown, where: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    bad(where, `must be an integer from ${min} to ${max}`);
  return v;
}

function parseRegion(v: unknown, where: string): DiffRegion {
  const r = object(v, where);
  const kind = REGION_KINDS.find((k) => k === r.kind);
  if (!kind) bad(`${where}.kind`, "is not a region kind");
  const region: DiffRegion = {
    x: int(r.x, `${where}.x`, 0),
    y: int(r.y, `${where}.y`, 0),
    w: int(r.w, `${where}.w`, 0),
    h: int(r.h, `${where}.h`, 0),
    changedPixels: int(r.changedPixels, `${where}.changedPixels`, 0),
    antialiasedPixels: int(r.antialiasedPixels, `${where}.antialiasedPixels`, 0),
    kind,
  };
  if (r.why !== undefined) region.why = text(r.why, `${where}.why`, 200);
  return region;
}

function strictFlake(raw: unknown): FlakeInput {
  const f = object(raw, "flake");
  const runs = int(f.runs, "flake.runs", 2, MAX_FLAKE_RUNS);
  if (!Array.isArray(f.differed) || f.differed.length === 0)
    bad("flake.differed", "must name at least one run");
  const differed = f.differed.map((r, i) => int(r, `flake.differed[${i}]`, 2, runs));
  if (new Set(differed).size !== differed.length) bad("flake.differed", "names a run twice");
  if (!Array.isArray(f.regions) || f.regions.length > runs)
    bad("flake.regions", "must be an array of one entry per run at most");
  const regions = f.regions.map((e, i) => {
    const o = object(e, `flake.regions[${i}]`);
    if (!Array.isArray(o.regions) || o.regions.length > MAX_FLAKE_REGIONS)
      bad(`flake.regions[${i}].regions`, `must be an array of at most ${MAX_FLAKE_REGIONS}`);
    return {
      run: int(o.run, `flake.regions[${i}].run`, 2, runs),
      regions: o.regions.map((r, j) => parseRegion(r, `flake.regions[${i}].regions[${j}]`)),
    };
  });
  const policy = f.policy;
  if (!isFlakyPolicy(policy)) bad("flake.policy", "is not a flaky policy");
  return {
    runs,
    differed: differed.toSorted((a, b) => a - b),
    regions,
    engineVersion: text(f.engineVersion, "flake.engineVersion", 64, TOKEN),
    policy,
  };
}

/**
 * `meta.flake`, the CLI's record of a shot whose captures disagreed (ob 1737). A record that does
 * not check out is dropped, not refused: the shot itself is still a good upload.
 */
export function parseFlake(raw: unknown): FlakeInput | null {
  if (raw === undefined || raw === null) return null;
  try {
    return strictFlake(raw);
  } catch (e) {
    if (e instanceof BadRequest) return null;
    throw e;
  }
}
