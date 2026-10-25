/**
 * The diff contract (ob 1909): the one command line any implementation of the diff can meet, so a
 * Rust, Go or C# engine can be scored and timed against the TypeScript one on the same pairs.
 * `bench/README.md` ("The diff contract") is the written form; this file reads what an
 * implementation prints and refuses what does not fit, naming the field.
 *
 *   <impl> diff <base.png> <head.png> --json
 */
import { isRecord } from "../corpus.ts";
import type { Rect } from "../regions.ts";

/** What an implementation prints on stdout: one JSON object. Fields it does not know are ignored. */
export type ImplOutput = {
  verdict: "changed" | "unchanged";
  /** Boxes of the changed regions, in pixels of the base image; noise-only regions are left out. */
  regions: Rect[];
  /** Its own time to decode both PNGs, in ms. Process start-up is not in it. */
  decode_ms: number;
  /** Its own time from decoded pixels to verdict and regions, in ms. */
  diff_ms: number;
  /** Optional (ob 1932): ms from the harness's spawn stamp (`PS_BENCH_SPAWN_AT`) to the first line of engine code. */
  startup_ms?: number;
  /** Optional (ob 1932): ms per named phase of `decode_ms` and `diff_ms`; an engine reports the ones it can. */
  phases?: Record<string, number>;
  /**
   * Optional (PS-168): the process's own peak resident set in bytes, read as it finishes (`VmHWM` on
   * Linux). The harness cannot take it from the child's rusage: Linux carries the parent's high-water
   * mark through fork and exec, so every child would report at least the runner's own size.
   */
  peak_rss_bytes?: number;
};

/** The spawn stamp the harness puts in the child's environment: epoch ms, fractional. */
export const SPAWN_AT_ENV = "PS_BENCH_SPAWN_AT";

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isCoord = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function parseRegion(raw: unknown, at: number): Rect {
  if (!isRecord(raw)) throw new Error(`regions[${at}] is not an object`);
  const { x, y, w, h } = raw;
  if (!isCoord(x) || !isCoord(y)) throw new Error(`regions[${at}] needs whole-number x and y >= 0`);
  if (!isSize(w) || !isSize(h)) throw new Error(`regions[${at}] needs whole-number w and h >= 1`);
  return { x, y, w, h };
}

/** Read the text an implementation printed. Throws a message naming what is wrong with it. */
export function parseImplOutput(text: string): ImplOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    const shown = text.trim().slice(0, 80);
    throw new Error(`stdout is not JSON: ${shown === "" ? "(empty)" : JSON.stringify(shown)}`);
  }
  if (!isRecord(raw) || Array.isArray(raw)) throw new Error("stdout is not a JSON object");
  const { verdict, regions, decode_ms, diff_ms, startup_ms, phases, peak_rss_bytes } = raw;
  if (verdict !== "changed" && verdict !== "unchanged")
    throw new Error(`verdict must be "changed" or "unchanged", got ${JSON.stringify(verdict)}`);
  if (!Array.isArray(regions)) throw new Error("regions must be an array");
  if (!isMs(decode_ms)) throw new Error("decode_ms must be a number >= 0");
  if (!isMs(diff_ms)) throw new Error("diff_ms must be a number >= 0");
  const out: ImplOutput = { verdict, regions: regions.map(parseRegion), decode_ms, diff_ms };
  return { ...out, ...parseTimings(startup_ms, phases, peak_rss_bytes) };
}

type Timings = Pick<ImplOutput, "startup_ms" | "phases" | "peak_rss_bytes">;

/** The optional startup_ms and phases (ob 1932) and peak_rss_bytes (PS-168): only the ones present. */
function parseTimings(startup: unknown, phases: unknown, rss: unknown): Timings {
  const out: Timings = {};
  if (startup !== undefined) {
    if (!isMs(startup)) throw new Error("startup_ms must be a number >= 0");
    out.startup_ms = startup;
  }
  if (phases !== undefined) out.phases = parsePhases(phases);
  if (rss !== undefined) {
    if (!isCoord(rss)) throw new Error("peak_rss_bytes must be a whole number >= 0");
    out.peak_rss_bytes = rss;
  }
  return out;
}

function parsePhases(raw: unknown): Record<string, number> {
  if (!isRecord(raw) || Array.isArray(raw)) throw new Error("phases must be an object");
  const phases: Record<string, number> = {};
  for (const [name, ms] of Object.entries(raw)) {
    if (!isMs(ms)) throw new Error(`phases.${name} must be a number >= 0`);
    phases[name] = ms;
  }
  return phases;
}
