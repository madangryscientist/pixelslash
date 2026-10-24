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
};

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
  const { verdict, regions, decode_ms, diff_ms } = raw;
  if (verdict !== "changed" && verdict !== "unchanged")
    throw new Error(`verdict must be "changed" or "unchanged", got ${JSON.stringify(verdict)}`);
  if (!Array.isArray(regions)) throw new Error("regions must be an array");
  if (!isMs(decode_ms)) throw new Error("decode_ms must be a number >= 0");
  if (!isMs(diff_ms)) throw new Error("diff_ms must be a number >= 0");
  return { verdict, regions: regions.map(parseRegion), decode_ms, diff_ms };
}
