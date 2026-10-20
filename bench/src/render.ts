/** Markdown tables and the side-by-side HTML page (ob 1477). */
import { type CalibrationRow } from "./calibration.ts";
import { ARGOS_THRESHOLD } from "./argos-cache.ts";
import { captureSection } from "./capture-render.ts";
import type { CaptureStage } from "./capture-stage.ts";
import { CORPUS_IDS, type CorpusId } from "./corpus.ts";
import {
  caseIou,
  scoreTool,
  verdictDisagreements,
  type KindScore,
  type ToolScore,
} from "./score.ts";
import type { CaseResult, ToolResult } from "./types.ts";

export type RunInfo = {
  date: string;
  pixelslashCommit: string;
  argosCommit: string | null;
};

const inCorpus = (rows: CaseResult[], id: CorpusId) => rows.filter((r) => r.case.corpus === id);

/** One tool's score on each corpus; Argos is null for a run made without it. */
type Scores = Record<CorpusId, { pixelslash: ToolScore; argos: ToolScore | null }>;

function scoresOf(rows: CaseResult[]): Scores {
  const hasArgos = rows.some((r) => r.argos);
  const one = (id: CorpusId) => {
    const own = inCorpus(rows, id);
    return {
      pixelslash: scoreTool(own, "pixelslash"),
      argos: hasArgos ? scoreTool(own, "argos") : null,
    };
  };
  return { main: one("main"), holdout: one("holdout") };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const frac = (n: number, d: number) => `${n}/${d} (${pct(n, d)})`;
function ms(v: number | null): string {
  if (v === null) return "n/a";
  return v.toFixed(v >= 100 ? 0 : 1);
}
const iouText = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));

const cell = (s: ToolScore | null, f: (s: ToolScore) => string) => (s ? f(s) : "not run");

/** The four columns of every table: each tool on the main corpus, then on the held-out one. */
const COLUMNS: Array<{ id: CorpusId; tool: "pixelslash" | "argos"; title: string }> = [
  { id: "main", tool: "pixelslash", title: "PixelSlash, main" },
  { id: "main", tool: "argos", title: "Argos, main" },
  { id: "holdout", tool: "pixelslash", title: "PixelSlash, holdout" },
  { id: "holdout", tool: "argos", title: "Argos, holdout" },
];

const tableHead = (first: string[]) => [
  `| ${[...first, ...COLUMNS.map((c) => c.title)].join(" | ")} |`,
  `| ${[...first, ...COLUMNS].map(() => "---").join(" | ")} |`,
];

function metrics(scores: Scores): string {
  const rows: Array<[string, (s: ToolScore) => string]> = [
    ["Real changes caught", (s) => frac(s.realCaught, s.realTotal)],
    ["Noise wrongly flagged (lower is better)", (s) => frac(s.noiseFlagged, s.noiseTotal)],
    [
      "Identical wrongly flagged (lower is better)",
      (s) => frac(s.identicalFlagged, s.identicalTotal),
    ],
    ["Region IoU on caught real changes (mean)", (s) => iouText(s.meanIouCaught)],
    ["Time per pair, median (ms)", (s) => ms(s.medianMs)],
    ["Time, all pairs (ms)", (s) => ms(s.totalMs)],
  ];
  const lines = tableHead([""]);
  for (const [name, f] of rows)
    lines.push(`| ${name} | ${COLUMNS.map((c) => cell(scores[c.id][c.tool], f)).join(" | ")} |`);
  return lines.join("\n");
}

const kindId = (k: KindScore) => `${k.label}/${k.kind}`;

function kindTable(scores: Scores): string {
  const order: string[] = [];
  const meta = new Map<string, { label: string; kind: string }>();
  for (const c of COLUMNS) {
    for (const k of scores[c.id][c.tool]?.byKind ?? []) {
      if (!meta.has(kindId(k))) {
        meta.set(kindId(k), { label: k.label, kind: k.kind });
        order.push(kindId(k));
      }
    }
  }
  const labelOrder = ["identical", "noise", "real"];
  order.sort((a, b) => {
    const [la, ka] = a.split("/");
    const [lb, kb] = b.split("/");
    return (
      labelOrder.indexOf(la ?? "") - labelOrder.indexOf(lb ?? "") ||
      (ka ?? "").localeCompare(kb ?? "")
    );
  });
  const lines = tableHead(["label", "kind"]);
  for (const id of order) {
    const m = meta.get(id);
    const cells = COLUMNS.map((c) => {
      const k = scores[c.id][c.tool]?.byKind.find((o) => kindId(o) === id);
      if (!scores[c.id][c.tool]) return "not run";
      return k ? frac(k.hit, k.total) : "none";
    });
    lines.push(`| ${m?.label} | ${m?.kind} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function verdictCell(r: ToolResult | null, iou: number | null): string {
  if (!r) return "not run";
  const where = iou === null ? "" : `, IoU ${iou.toFixed(2)}`;
  return `${r.changed ? "changed" : "same"} (${r.note}${where})`;
}

function agreeText(r: CaseResult): string {
  if (r.argos === null) return "";
  return r.argos.changed === r.pixelslash.changed ? "yes" : "**NO**";
}

function caseTable(rows: CaseResult[]): string {
  const lines = [
    "| case | label | PixelSlash | Argos | agree |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const agree = agreeText(r);
    lines.push(
      `| ${r.case.name} | ${r.case.label} | ${verdictCell(r.pixelslash, caseIou(r, "pixelslash"))} | ${verdictCell(r.argos, caseIou(r, "argos"))} | ${agree} |`,
    );
  }
  return lines.join("\n");
}

const right = (r: ToolResult, expect: boolean) => r.changed === expect;

function calibrationSection(rows: CalibrationRow[]): string {
  const argosRight = rows.filter((r) => right(r.argos, r.expectChanged)).length;
  const psRight = rows.filter((r) => right(r.pixelslash, r.expectChanged)).length;
  const lines = [
    "## Argos's own calibration cases",
    "",
    "Their 19 named cases (`diffImages` test table), streamed from the argos-bench image for this run and not copied into the repo. Expected is what their test asserts at the threshold shown. Where Argos itself disagrees with that, the wrapper or the pinned commit has drifted.",
    "",
    `Matches their expected verdict: Argos ${frac(argosRight, rows.length)}, PixelSlash ${frac(psRight, rows.length)}.`,
    "",
    "| case | threshold | expected | Argos | PixelSlash |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    const mark = (t: ToolResult) =>
      `${t.changed ? "changed" : "same"} (${t.note})${right(t, r.expectChanged) ? "" : " **x**"}`;
    lines.push(
      `| ${r.name} | ${r.threshold} | ${r.expectChanged ? "changed" : "unchanged"} | ${mark(r.argos)} | ${mark(r.pixelslash)} |`,
    );
  }
  return lines.join("\n");
}

/** The tables printed at the end of a run and written to results/<date>.md. */
export function summaryMarkdown(rows: CaseResult[]): string {
  const scores = scoresOf(rows);
  const parts = [metrics(scores), "", kindTable(scores)];
  for (const id of CORPUS_IDS) {
    const misses = inCorpus(rows, id).filter(
      (r) => r.case.label === "real" && !r.pixelslash.changed && r.pixelslash.sizeMismatch,
    ).length;
    if (misses > 0) {
      parts.push(
        "",
        `${id} corpus: ${misses} of PixelSlash's misses are size-mismatch cases: it diffs only the overlapping rectangle (invariant 1), finds nothing in it, and the report states both sizes. Argos pads the smaller shot and counts the padding as changed.`,
      );
    }
  }
  return parts.join("\n");
}

const COMPOSITION = (rows: CaseResult[]) => {
  const counts = (l: string) => rows.filter((r) => r.case.label === l).length;
  return `${rows.length} pairs (${counts("real")} real, ${counts("noise")} noise, ${counts("identical")} identical)`;
};

export function resultsMarkdown(
  rows: CaseResult[],
  info: RunInfo,
  cal: CalibrationRow[] | null,
  capture: CaptureStage | null = null,
): string {
  const disagree = verdictDisagreements(rows);
  const main = inCorpus(rows, "main");
  const holdout = inCorpus(rows, "holdout");
  const parts = [
    `# PixelSlash vs Argos, ${info.date}`,
    "",
    `Two corpora, scored the same way for both tools: \`bench/corpus/\` (main), ${COMPOSITION(main)}, and \`bench/corpus-holdout/\` (held out), ${COMPOSITION(holdout)}. Tuning work looks at the main corpus only; the held-out one, made from pages the main corpus never sees, says whether a change helped beyond them. \`bun run bench\` reproduces this; \`bench/README.md\` says how it is measured.`,
    "",
    `- PixelSlash: \`${info.pixelslashCommit}\`, \`diffPngs\` at its defaults (perceptual threshold, anti-aliased edges set aside, a size mismatch is a change). It reports a count and an overlay, not regions: regions are extracted from the overlay for both tools by the same code.`,
    `- Argos: ${info.argosCommit ? `\`${info.argosCommit}\`` : "not run"}, \`diffImages\` at threshold ${ARGOS_THRESHOLD}, answers from \`bench/argos-cache.json\` (VM 101 only for new or changed pairs, \`--refresh-argos\`). Its time is \`diffImages\` alone, as measured when the cache entry was made, without ssh, tar or container start.`,
    "",
    "## Scores",
    "",
    summaryMarkdown(rows),
    "",
    `## Where the tools disagree (${disagree.length})`,
    "",
    disagree.length === 0
      ? "None."
      : disagree
          .map(
            (r) =>
              `- ${r.case.corpus}/${r.case.name} (${r.case.label}): PixelSlash ${r.pixelslash.changed ? "changed" : "same"}, Argos ${r.argos?.changed ? "changed" : "same"}`,
          )
          .join("\n"),
    "",
    "Both tools' diff images side by side: `results/" + info.date + "/disagreements.html`.",
    "",
    "## Every case, main corpus",
    "",
    caseTable(main),
    "",
    "## Every case, held-out corpus",
    "",
    caseTable(holdout),
  ];
  if (cal) parts.push("", calibrationSection(cal));
  if (capture) parts.push("", captureSection(capture));
  return `${parts.join("\n")}\n`;
}
