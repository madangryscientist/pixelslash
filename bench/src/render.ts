/** Markdown tables and the side-by-side HTML page (ob 1477). */
import { type CalibrationRow } from "./calibration.ts";
import { caseIou, scoreTool, verdictDisagreements, type ToolScore } from "./score.ts";
import type { CaseResult, ToolResult } from "./types.ts";

export type RunInfo = {
  date: string;
  pixelslashCommit: string;
  argosCommit: string | null;
  argosWallMs: number | null;
};

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const frac = (n: number, d: number) => `${n}/${d} (${pct(n, d)})`;
function ms(v: number | null): string {
  if (v === null) return "n/a";
  return v.toFixed(v >= 100 ? 0 : 1);
}
const iouText = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));

const cell = (s: ToolScore | null, f: (s: ToolScore) => string) => (s ? f(s) : "not run");

function metrics(a: ToolScore, b: ToolScore | null): string {
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
  return [
    "| | PixelSlash | Argos |",
    "| --- | --- | --- |",
    ...rows.map(([name, f]) => `| ${name} | ${cell(a, f)} | ${cell(b, f)} |`),
  ].join("\n");
}

function kindTable(a: ToolScore, b: ToolScore | null): string {
  const lines = [
    "| label | kind | cases | PixelSlash right | Argos right |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const k of a.byKind) {
    const other = b?.byKind.find((o) => o.kind === k.kind && o.label === k.label);
    lines.push(
      `| ${k.label} | ${k.kind} | ${k.total} | ${frac(k.hit, k.total)} | ${other ? frac(other.hit, other.total) : "not run"} |`,
    );
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
  const ps = scoreTool(rows, "pixelslash");
  const argos = rows.some((r) => r.argos) ? scoreTool(rows, "argos") : null;
  const mismatchMisses = rows.filter(
    (r) => r.case.label === "real" && !r.pixelslash.changed && r.pixelslash.sizeMismatch,
  ).length;
  const parts = [metrics(ps, argos), "", kindTable(ps, argos)];
  if (mismatchMisses > 0) {
    parts.push(
      "",
      `${mismatchMisses} of PixelSlash's misses are size-mismatch cases: it diffs only the overlapping rectangle (invariant 1), finds nothing in it, and the report states both sizes. Argos pads the smaller shot and counts the padding as changed.`,
    );
  }
  return parts.join("\n");
}

export function resultsMarkdown(
  rows: CaseResult[],
  info: RunInfo,
  cal: CalibrationRow[] | null,
): string {
  const counts = (l: string) => rows.filter((r) => r.case.label === l).length;
  const disagree = verdictDisagreements(rows);
  const parts = [
    `# PixelSlash vs Argos, ${info.date}`,
    "",
    `${rows.length} labelled pairs (${counts("real")} real, ${counts("noise")} noise, ${counts("identical")} identical) from \`bench/corpus/\`, each scored the same way for both tools. \`bun run bench\` reproduces this; \`bench/README.md\` says how it is measured.`,
    "",
    `- PixelSlash: \`${info.pixelslashCommit}\`, \`diffPngs\` as it is (exact pixels, no tolerance, no anti-aliasing detection). It reports a count and an overlay, not regions: regions are extracted from the overlay for both tools by the same code.`,
    `- Argos: ${info.argosCommit ? `\`${info.argosCommit}\`` : "commit unknown"}, \`diffImages\` at threshold 0.5, in VM 101 (ops/argos-bench). Its time is \`diffImages\` alone, without ssh, tar or container start${info.argosWallMs === null ? "" : `; the whole run, those included, took ${(info.argosWallMs / 1000).toFixed(1)} s`}.`,
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
              `- ${r.case.name} (${r.case.label}): PixelSlash ${r.pixelslash.changed ? "changed" : "same"}, Argos ${r.argos?.changed ? "changed" : "same"}`,
          )
          .join("\n"),
    "",
    "Both tools' diff images side by side: `results/" + info.date + "/disagreements.html`.",
    "",
    "## Every case",
    "",
    caseTable(rows),
  ];
  if (cal) parts.push("", calibrationSection(cal));
  return `${parts.join("\n")}\n`;
}
