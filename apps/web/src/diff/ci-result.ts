import { changedOf } from "@pixelslash/engine/diff";
import type { DiffOptions, DiffRegion, DiffResult, IgnoreRect } from "#/db/schema";

/**
 * A CI project's results (ob 1727): the CLI diffs each shot against the baseline the server picked
 * and sends what it measured. The server never decodes a PNG for them; it checks that each result
 * is a result — the right shape, inside the image, its counts agreeing with each other and with the
 * status — and stores it as sent. One that fails is refused by name, and the shot is not measured
 * on the server instead.
 */

/** What an upload stores in `snapshots.ci_results`, unchecked until finalise. */
export type CiUpload = {
  /** The engine that measured the results, as the CLI reported it. */
  engineVersion: string;
  /** The shot's own size, read from its PNG header at upload: `branchWidth`/`branchHeight` must match. */
  image: { width: number; height: number };
  /** One per baseline the CLI measured against; at most two (the shot and, when carrying, the accepted one). */
  results: { baselineId: string; status: unknown; diffResult: unknown; diffKey: string }[];
};

/** A result for one baseline that passed the checks. */
export type CheckedResult = {
  changed: boolean;
  diffResult: DiffResult;
  diffKey: string;
  engineVersion: string;
};

/** Why a shot's CI result was refused; becomes the shot's `diff_error` and part of the build's error. */
export class CiResultError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(what: string): never {
  throw new CiResultError(`invalid result: ${what}`);
}

function count(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    fail(`${where} must be a non-negative integer`);
  return v;
}

function size(v: unknown, where: string): number {
  const n = count(v, where);
  if (n === 0) fail(`${where} must be positive`);
  return n;
}

type Box = { x: number; y: number; w: number; h: number };
type Area = { w: number; h: number };

/** A box that lies inside the overlap. */
function inside(box: Box, { w, h }: Area, where: string) {
  if (box.x + box.w > w || box.y + box.h > h) fail(`${where} lies outside the ${w}x${h} overlap`);
}

function rect(v: unknown, area: Area, where: string): IgnoreRect {
  if (!isObj(v)) fail(`${where} must be an object`);
  const out = {
    x: count(v.x, `${where}.x`),
    y: count(v.y, `${where}.y`),
    width: size(v.width, `${where}.width`),
    height: size(v.height, `${where}.height`),
  };
  inside({ x: out.x, y: out.y, w: out.width, h: out.height }, area, where);
  return out;
}

function region(v: unknown, area: Area, where: string): DiffRegion {
  if (!isObj(v)) fail(`${where} must be an object`);
  const kind = v.kind;
  if (kind !== "change" && kind !== "noise" && kind !== "shift")
    fail(`${where}.kind must be change, noise or shift`);
  const out: DiffRegion = {
    x: count(v.x, `${where}.x`),
    y: count(v.y, `${where}.y`),
    w: size(v.w, `${where}.w`),
    h: size(v.h, `${where}.h`),
    changedPixels: count(v.changedPixels, `${where}.changedPixels`),
    antialiasedPixels: count(v.antialiasedPixels, `${where}.antialiasedPixels`),
    kind,
  };
  if (v.why !== undefined) {
    if (typeof v.why !== "string" || v.why.length > 200)
      fail(`${where}.why must be a short string`);
    out.why = v.why;
  }
  inside(out, area, where);
  if (out.changedPixels + out.antialiasedPixels > out.w * out.h)
    fail(`${where} counts more pixels than its box holds`);
  return out;
}

function list<T>(v: unknown, where: string, max: number, each: (item: unknown, at: string) => T) {
  if (!Array.isArray(v) || v.length > max) fail(`${where} must be an array of at most ${max}`);
  return v.map((item, i) => each(item, `${where}[${i}]`));
}

const MAX_REGIONS = 10_000;

type Size = CiUpload["image"];

/** One side's size as the summary states it, which must be what that PNG's header says. */
function sizeOf(raw: Record<string, unknown>, side: "main" | "branch", png: Size): Size {
  const width = size(raw[`${side}Width`], `${side}Width`);
  const height = size(raw[`${side}Height`], `${side}Height`);
  const whose = side === "main" ? "the baseline's" : "the shot's";
  if (width !== png.width || height !== png.height)
    fail(`${side} size ${width}x${height} is not ${whose} ${png.width}x${png.height}`);
  return { width, height };
}

/** The summary's shape and its sizes, which must agree with the two PNGs' own headers. */
function shapeOf(raw: unknown, image: Size, against: Size): DiffResult {
  if (!isObj(raw)) fail("diffResult must be an object");
  const main = sizeOf(raw, "main", against);
  const branch = sizeOf(raw, "branch", image);
  const [mainWidth, mainHeight] = [main.width, main.height];
  const [branchWidth, branchHeight] = [branch.width, branch.height];
  const width = count(raw.width, "width");
  const height = count(raw.height, "height");
  if (width !== Math.min(mainWidth, branchWidth) || height !== Math.min(mainHeight, branchHeight))
    fail(`width/height ${width}x${height} is not the overlap of the two shots`);
  const sizeChanged = mainWidth !== branchWidth || mainHeight !== branchHeight;
  if (raw.sizeChanged !== sizeChanged) fail(`sizeChanged must be ${sizeChanged}`);
  if (!isObj(raw.specks)) fail("specks must be an object");
  const area = { w: width, h: height };
  return {
    changedPixels: count(raw.changedPixels, "changedPixels"),
    antialiasedPixels: count(raw.antialiasedPixels, "antialiasedPixels"),
    ignoredPixels: count(raw.ignoredPixels, "ignoredPixels"),
    ignored: list(raw.ignored, "ignored", MAX_REGIONS, (r, at) => rect(r, area, at)),
    specks: {
      count: count(raw.specks.count, "specks.count"),
      pixels: count(raw.specks.pixels, "specks.pixels"),
    },
    regions: list(raw.regions, "regions", MAX_REGIONS, (r, at) => region(r, area, at)),
    width,
    height,
    mainWidth,
    mainHeight,
    branchWidth,
    branchHeight,
    sizeChanged,
  };
}

/** The counts agree with each other: nothing counts more pixels than the overlap or its parts hold. */
function checkCounts(r: DiffResult): void {
  const area = r.width * r.height;
  if (r.ignoredPixels > area) fail("ignoredPixels exceeds the overlap");
  if (r.changedPixels + r.antialiasedPixels + r.ignoredPixels > area)
    fail("changed, anti-aliased and ignored pixels exceed the overlap");
  const boxed = r.regions.reduce((n, g) => n + g.changedPixels, 0);
  if (boxed + r.specks.pixels > r.changedPixels)
    fail("the regions and specks count more pixels than changedPixels");
  if (r.specks.pixels < r.specks.count) fail("specks.pixels is fewer than specks.count");
}

function isSent(v: unknown): v is CiUpload["results"][number] {
  return isObj(v) && typeof v.baselineId === "string" && typeof v.diffKey === "string";
}

/** What the upload stored, read back: null when it stored no result. */
function uploadOf(stored: unknown): CiUpload | null {
  if (!isObj(stored) || !Array.isArray(stored.results) || stored.results.length === 0) return null;
  const { engineVersion, image, results } = stored;
  if (typeof engineVersion !== "string" || !results.every(isSent) || !isObj(image)) return null;
  const width = size(image.width, "image.width");
  const height = size(image.height, "image.height");
  return { engineVersion, image: { width, height }, results };
}

/** The baseline a result is checked against: its id, and its size from its PNG header. */
export type CheckedAgainst = { id: string; size: Size };

/**
 * Check the result a CI run sent for `baseline`. Throws `CiResultError` naming the reason: no
 * result at all, none for this baseline (the CLI measured against a pick that is no longer the
 * server's), or one that is not a result.
 */
export function checkCiResult(
  stored: unknown,
  baseline: CheckedAgainst,
  options: DiffOptions,
): CheckedResult {
  const baselineId = baseline.id;
  const upload = uploadOf(stored);
  if (!upload) throw new CiResultError("no result: the CLI sent no diff for this shot");
  const sent = upload.results.find((r) => r.baselineId === baselineId);
  if (!sent) {
    const ids = upload.results.map((r) => r.baselineId).join(", ");
    throw new CiResultError(
      `stale baseline: the CLI measured against ${ids}, the server picked ${baselineId}`,
    );
  }
  const status: unknown = sent.status;
  if (status !== "changed" && status !== "unchanged") fail("status must be changed or unchanged");
  const diffResult = shapeOf(sent.diffResult, upload.image, baseline.size);
  checkCounts(diffResult);
  const changed = changedOf(diffResult, options);
  if ((status === "changed") !== changed)
    fail(`status ${status} does not follow from the result under the shot's thresholds`);
  return { changed, diffResult, diffKey: sent.diffKey, engineVersion: upload.engineVersion };
}
