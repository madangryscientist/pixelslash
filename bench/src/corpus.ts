/** The corpus on disk (ob 1477): `bench/corpus/<case>/{base.png,head.png,label.json}`. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rect } from "./regions.ts";
import type { Label } from "./cases.ts";

export const BENCH_DIR = join(import.meta.dir, "..");
export const CORPUS_DIR = join(BENCH_DIR, "corpus");

export type CaseLabel = {
  label: Label;
  kind: string;
  page: string;
  width: number;
  height: number;
  /** `real` cases: the ground-truth changed region. */
  box?: Rect;
};

export type CorpusCase = CaseLabel & { name: string; dir: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isLabel(v: unknown): v is Label {
  return v === "identical" || v === "noise" || v === "real";
}

export function parseLabel(text: string): CaseLabel {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("label.json is not an object");
  const { label, kind, page, width, height, box } = raw;
  if (!isLabel(label)) throw new Error(`bad label: ${String(label)}`);
  if (typeof kind !== "string" || typeof page !== "string") throw new Error("bad kind/page");
  if (typeof width !== "number" || typeof height !== "number") throw new Error("bad size");
  const parsed: CaseLabel = { label, kind, page, width, height };
  if (box !== undefined) parsed.box = parseRect(box);
  if (label === "real" && !parsed.box) throw new Error("a real case needs a box");
  return parsed;
}

function parseRect(raw: unknown): Rect {
  if (!isRecord(raw)) throw new Error("box is not an object");
  const { x, y, w, h } = raw;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  )
    throw new Error("box needs numeric x y w h");
  return { x, y, w, h };
}

export function loadCorpus(root = CORPUS_DIR): CorpusCase[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted()
    .map((name) => {
      const dir = join(root, name);
      return { name, dir, ...parseLabel(readFileSync(join(dir, "label.json"), "utf8")) };
    });
}
