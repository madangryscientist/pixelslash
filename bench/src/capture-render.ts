/** The capture-stage section of the results (ob 1489). */
import {
  ARMS,
  PAIRS,
  flagged,
  flickers,
  type Arm,
  type CaptureStage,
  type CaptureStageRow,
  type PairOutcome,
} from "./capture-stage.ts";
import type { Rect } from "./regions.ts";

const ARM_TITLE: Record<Arm, string> = {
  image: "pinned image",
  bare: "bare",
  control: "control (stabilisation off)",
};

function cell(pairs: PairOutcome[]): string {
  const bad = pairs.filter(flickers);
  if (bad.length === 0) return `0/${pairs.length}`;
  const failed = bad.find((o) => o.kind === "failed");
  if (failed?.kind === "failed") return `${bad.length}/${pairs.length}, failed: ${failed.error}`;
  const px = Math.max(0, ...bad.map((o) => (o.kind === "diffed" ? o.changedPx : 0)));
  return `${bad.length}/${pairs.length}, up to ${px} px`;
}

function union(regions: Rect[]): string {
  if (regions.length === 0) return "no region";
  const x1 = Math.min(...regions.map((r) => r.x));
  const y1 = Math.min(...regions.map((r) => r.y));
  const x2 = Math.max(...regions.map((r) => r.x + r.w));
  const y2 = Math.max(...regions.map((r) => r.y + r.h));
  return `${x2 - x1}x${y2 - y1} at ${x1},${y1}`;
}

function whereDiffers(outcome: PairOutcome | undefined): string {
  if (outcome?.kind !== "diffed") return "";
  if (outcome.sizeMismatch) return "the two shots are different sizes";
  return `the diff covers ${union(outcome.regions)}`;
}

/** One line naming a page the image still flags, and why. */
function why(row: CaptureStageRow): string {
  const pairs = row.arms.image;
  const failed = pairs.find((o) => o.kind === "failed");
  if (failed?.kind === "failed")
    return `- **${row.page.name}**: a capture failed in the image (${failed.error}).`;
  const where = whereDiffers(pairs.find(flickers));
  return `- **${row.page.name}**: ${flagged(pairs)}/${pairs.length} pairs differ; ${where}. The page's noise is ${row.page.noise}, which the image's stabilisation does not remove.`;
}

/** The control is only evidence if it flickers: say which pages it did and did not. */
function controlNote(rows: CaptureStageRow[]): string {
  const quiet = rows.filter((r) => flagged(r.arms.control) === 0).map((r) => r.page.name);
  if (quiet.length === 0) return "The control flagged every page.";
  return `The control did not flag ${quiet.join(", ")}: on those, a clean image row shows no more than that the page did not flicker here.`;
}

export function captureSection(stage: CaptureStage): string {
  const bad = stage.rows.filter((r) => flagged(r.arms.image) > 0);
  const head = [
    "## Capture stage",
    "",
    `Each fixture page (\`bench/fixtures-capture/\`) is captured ${2 * PAIRS} times by \`pixelslash capture\` per arm, as ${PAIRS} pairs; each pair is diffed by the engine. A cell is the pairs falsely flagged: nothing on the page changed between the two shots. Argos is not involved. The pinned image is \`${stage.imageVersion}\`; bare is this machine. The control is the bare CLI with animations, caret and clock left alone; the settle always runs.`,
    "",
    `| page | noise | ${ARMS.map((a) => ARM_TITLE[a]).join(" | ")} |`,
    `| --- | --- | ${ARMS.map(() => "---").join(" | ")} |`,
    ...stage.rows.map(
      (r) =>
        `| ${r.page.name} | ${r.page.noise} | ${ARMS.map((a) => cell(r.arms[a])).join(" | ")} |`,
    ),
    "",
  ];
  const verdict =
    bad.length === 0
      ? [`The pinned image produced 0 false changes on every page.`]
      : [
          `The pinned image falsely flagged ${bad.length} of ${stage.rows.length} pages:`,
          "",
          ...bad.map(why),
        ];
  return [...head, ...verdict, "", controlNote(stage.rows)].join("\n");
}
