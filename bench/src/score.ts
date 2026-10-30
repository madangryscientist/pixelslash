/** Scoring (ob 1477): the same measures for each tool, from the labelled cases. */
import { iou } from "./regions.ts";
import type { CaseResult, ToolResult } from "./types.ts";

export type Tool = "pixelslash" | "argos";

export type KindScore = { kind: string; label: string; hit: number; total: number };

export type ToolScore = {
  /** real cases flagged changed */
  realCaught: number;
  realTotal: number;
  /** mean IoU over the real cases the tool flagged; null when it flagged none */
  meanIouCaught: number | null;
  /** mean IoU over the real cases both tools flagged; null without Argos or without such a case */
  meanIouBoth: number | null;
  /** noise cases wrongly flagged */
  noiseFlagged: number;
  noiseTotal: number;
  /** identical cases wrongly flagged */
  identicalFlagged: number;
  identicalTotal: number;
  medianMs: number | null;
  totalMs: number | null;
  byKind: KindScore[];
};

export function resultFor(row: CaseResult, tool: Tool): ToolResult | null {
  return tool === "argos" ? row.argos : row.pixelslash;
}

export function caseIou(row: CaseResult, tool: Tool): number | null {
  const r = resultFor(row, tool);
  const box = row.case.box;
  if (!r || !box) return null;
  return iou(r.regions, box, row.case.width, row.case.height);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

type Tally = {
  score: ToolScore;
  ious: number[];
  bothIous: number[];
  times: number[];
  kinds: Map<string, KindScore>;
};

function tallyKind(t: Tally, row: CaseResult, r: ToolResult): void {
  const label = row.case.label;
  const key = `${label}/${row.case.kind}`;
  const k = t.kinds.get(key) ?? { kind: row.case.kind, label, hit: 0, total: 0 };
  k.total++;
  // "hit" is the tool doing the right thing: flag a real change, leave noise and identical alone.
  if (label === "real" ? r.changed : !r.changed) k.hit++;
  t.kinds.set(key, k);
}

/** Add one tool verdict to the running tally. */
function tally(t: Tally, row: CaseResult, r: ToolResult, tool: Tool): void {
  const label = row.case.label;
  if (r.ms !== null) t.times.push(r.ms);
  tallyKind(t, row, r);
  if (label === "real") {
    t.score.realTotal++;
    if (!r.changed) return;
    t.score.realCaught++;
    t.ious.push(caseIou(row, tool) ?? 0);
    if (row.argos?.changed) t.bothIous.push(caseIou(row, tool) ?? 0);
  } else if (label === "noise") {
    t.score.noiseTotal++;
    t.score.noiseFlagged += Number(r.changed);
  } else {
    t.score.identicalTotal++;
    t.score.identicalFlagged += Number(r.changed);
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function scoreTool(rows: CaseResult[], tool: Tool): ToolScore {
  const t: Tally = {
    score: {
      realCaught: 0,
      realTotal: 0,
      meanIouCaught: null,
      meanIouBoth: null,
      noiseFlagged: 0,
      noiseTotal: 0,
      identicalFlagged: 0,
      identicalTotal: 0,
      medianMs: null,
      totalMs: null,
      byKind: [],
    },
    ious: [],
    bothIous: [],
    times: [],
    kinds: new Map(),
  };
  for (const row of rows) {
    const r = resultFor(row, tool);
    if (r) tally(t, row, r, tool);
  }
  t.score.meanIouCaught = t.ious.length > 0 ? sum(t.ious) / t.ious.length : null;
  t.score.meanIouBoth = t.bothIous.length > 0 ? sum(t.bothIous) / t.bothIous.length : null;
  t.score.medianMs = median(t.times);
  t.score.totalMs = t.times.length > 0 ? sum(t.times) : null;
  t.score.byKind = [...t.kinds.values()];
  return t.score;
}

/** Cases where the two tools reach a different verdict. */
export function verdictDisagreements(rows: CaseResult[]): CaseResult[] {
  return rows.filter((r) => r.argos !== null && r.argos.changed !== r.pixelslash.changed);
}

/** Real cases both tools flag but point at different places (IoU differs by at least `gap`). */
export function locationDisagreements(rows: CaseResult[], gap = 0.3): CaseResult[] {
  return rows.filter((r) => {
    if (r.case.label !== "real" || !r.argos || !r.argos.changed || !r.pixelslash.changed)
      return false;
    const a = caseIou(r, "pixelslash") ?? 0;
    const b = caseIou(r, "argos") ?? 0;
    return Math.abs(a - b) >= gap;
  });
}
