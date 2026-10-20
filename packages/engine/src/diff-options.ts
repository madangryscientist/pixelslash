import { DEFAULT_THRESHOLD, type DiffOptions } from "./diff.ts";
import {
  DEFAULT_MERGE_DISTANCE,
  DEFAULT_MIN_REGION_AREA,
  DEFAULT_NOISE_AMPLITUDE,
} from "./regions.ts";

/** Reports a bad value; the caller picks the error style (`config: …`, `manifest: …`). */
export type Fail = (where: string, what: string) => never;

type Rule = (v: unknown, where: string, fail: Fail) => number;

function unit(v: unknown, where: string, fail: Fail): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
    fail(where, "must be a number from 0 to 1");
  return v;
}

function count(v: unknown, where: string, fail: Fail): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    fail(where, "must be a non-negative integer");
  return v;
}

/**
 * One rule per `DiffOptions` key. `satisfies` makes a key added to `DiffOptions` a type error
 * until it has a rule here, so it is validated, resolved and stored without another change.
 */
const RULES = {
  threshold: unit,
  minChangedPixels: count,
  minChangedRatio: unit,
  mergeDistance: count,
  minRegionArea: count,
  noiseAmplitude: unit,
} satisfies Record<keyof DiffOptions, Rule>;

function isKey(k: string): k is keyof DiffOptions {
  return Object.hasOwn(RULES, k);
}

const KEYS = Object.keys(RULES).filter(isKey);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one option's value; `where` names it in the error. */
export function parseDiffOption(
  key: keyof DiffOptions,
  v: unknown,
  where: string,
  fail: Fail,
): number {
  return RULES[key](v, where, fail);
}

/** Validate a raw `diff` object. Only the keys it names are in the result; unknown keys are refused. */
export function parseDiffOptions(v: unknown, where: string, fail: Fail): DiffOptions {
  if (!isRecord(v)) fail(where, `must be an object with ${KEYS.join(", ")}`);
  for (const key of Object.keys(v)) {
    if (!isKey(key)) fail(`${where}.${key}`, `is not a diff option (${KEYS.join(", ")})`);
  }
  const out: DiffOptions = {};
  for (const key of KEYS) {
    if (v[key] !== undefined) out[key] = parseDiffOption(key, v[key], `${where}.${key}`, fail);
  }
  return out;
}

/** Layers from least to most specific; a key set in a later layer wins. Engine defaults are not injected. */
export function mergeDiffOptions(...layers: DiffOptions[]): DiffOptions {
  const out: DiffOptions = {};
  for (const layer of layers) {
    for (const key of KEYS) {
      if (layer[key] !== undefined) out[key] = layer[key];
    }
  }
  return out;
}

/** What `diffPngs` assumes for a key nobody set (its `?? 0` floors; the threshold and region keys are the engine's `DEFAULT_*`). Keep in step. */
const ENGINE_DEFAULTS: Required<DiffOptions> = {
  threshold: DEFAULT_THRESHOLD,
  minChangedPixels: 0,
  minChangedRatio: 0,
  mergeDistance: DEFAULT_MERGE_DISTANCE,
  minRegionArea: DEFAULT_MIN_REGION_AREA,
  noiseAmplitude: DEFAULT_NOISE_AMPLITUDE,
};

const LABELS: Record<keyof DiffOptions, string> = {
  threshold: "threshold",
  minChangedPixels: "min changed pixels",
  minChangedRatio: "min changed ratio",
  mergeDistance: "merge distance",
  minRegionArea: "min region area",
  noiseAmplitude: "noise amplitude",
};

/** The options that differ from the engine defaults, as `threshold 0.2 · min changed pixels 50`; "" if none. */
export function describeDiffOptions(options: DiffOptions): string {
  return KEYS.filter((k) => options[k] !== undefined && options[k] !== ENGINE_DEFAULTS[k])
    .map((k) => `${LABELS[k]} ${options[k]}`)
    .join(" · ");
}
