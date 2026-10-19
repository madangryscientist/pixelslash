import type { CorpusCase } from "./corpus.ts";
import type { Rect } from "./regions.ts";

/** What one tool said about one pair. */
export type ToolResult = {
  changed: boolean;
  /** Boxes of the changed pixels, from the tool's mask via `extractRegions`. */
  regions: Rect[];
  /** Wall time of the comparison alone; null when the tool did not report one. */
  ms: number | null;
  /** The tool's own number: "19794 px" for PixelSlash, "score 0.0074" for Argos. */
  note: string;
  /** The tool's diff image (PNG bytes), if it made one. */
  diffPng: Buffer | null;
  /** Set when the two shots differ in size (PixelSlash diffs only the overlap). */
  sizeMismatch: boolean;
};

export type CaseResult = {
  case: CorpusCase;
  pixelslash: ToolResult;
  /** Null when the run was made with --no-argos. */
  argos: ToolResult | null;
};
