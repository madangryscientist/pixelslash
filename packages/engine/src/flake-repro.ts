import { type DiffOptions, type IgnoreRect, diffPngs } from "./diff.ts";
import type { CaptureConfig, Route, Variant } from "./config.ts";
import type { Region, RegionKind } from "./regions.ts";
import { esc } from "./report.ts";
import type { Shoot } from "./snapshot.ts";

/**
 * `pixelslash flake <id>` (ob 1725): one shot captured locally N times and each run diffed with
 * the first. It says whether the page renders the same twice here, where it does not, what the
 * engine calls each difference, and what to change. Nothing here touches a server.
 */

/** What the engine calls a difference between two runs. */
export type FlakeCause = "size" | RegionKind;

export const CAUSE_WORDS: Record<FlakeCause, string> = {
  size: "size change",
  change: "real change",
  shift: "sub-pixel shift",
  noise: "noise",
};

export type ReproRun = {
  run: number;
  /** The engine's verdict under the shot's own diff options and ignore areas. */
  differed: boolean;
  causes: FlakeCause[];
  /** Every region against run 1, `noise` and `shift` included; empty for run 1. */
  regions: Region[];
  width: number;
  height: number;
  /** The diff overlay against run 1; absent for run 1. */
  overlay?: Buffer;
};

export type Repro = {
  runs: ReproRun[];
  /** The runs that differed from run 1. */
  differed: number[];
  stable: boolean;
  /** The box around every `change` region of every run that differed, in image px. */
  area: IgnoreRect | undefined;
};

function causesOf(sized: boolean, regions: Region[]): FlakeCause[] {
  const kinds = new Set(regions.map((r) => r.kind));
  const order: RegionKind[] = ["change", "shift", "noise"];
  return [...(sized ? (["size"] as const) : []), ...order.filter((k) => kinds.has(k))];
}

function bounds(regions: Region[]): IgnoreRect | undefined {
  if (regions.length === 0) return undefined;
  const x = Math.min(...regions.map((r) => r.x));
  const y = Math.min(...regions.map((r) => r.y));
  const x1 = Math.max(...regions.map((r) => r.x + r.w));
  const y1 = Math.max(...regions.map((r) => r.y + r.h));
  return { x, y, width: x1 - x, height: y1 - y };
}

/** A PNG's size, from its IHDR. */
const sizeOf = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** Diff every capture against the first, as the upload's flake pass does. */
export function measureRepro(shots: Shoot[], options: DiffOptions): Repro {
  const [first, ...rest] = shots;
  if (!first) throw new Error("measureRepro needs at least one capture");
  const runs: ReproRun[] = [
    { run: 1, differed: false, causes: [], regions: [], ...sizeOf(first.png) },
  ];
  for (const [i, shot] of rest.entries()) {
    const diff = diffPngs(first.png, shot.png, options, {
      main: first.ignore,
      branch: shot.ignore,
    });
    const sized = diff.mainWidth !== diff.branchWidth || diff.mainHeight !== diff.branchHeight;
    runs.push({
      run: i + 2,
      differed: diff.changed,
      causes: causesOf(sized, diff.regions),
      regions: diff.regions,
      width: diff.branchWidth,
      height: diff.branchHeight,
      ...(diff.overlay && { overlay: diff.overlay }),
    });
  }
  const differing = runs.filter((r) => r.differed);
  return {
    runs,
    differed: differing.map((r) => r.run),
    stable: differing.length === 0,
    area: bounds(differing.flatMap((r) => r.regions.filter((g) => g.kind === "change"))),
  };
}

/** A change to the config, in its own words: what `--write` would add. */
export type ConfigEdit =
  | { kind: "ignore"; route: string; variant: string; rect: IgnoreRect }
  | { kind: "stabilise"; key: "animations" | "caret" | "timers"; value: true }
  | { kind: "stabilise"; key: "clock"; value: string }
  | { kind: "flaky-skip"; route: string };

export type Suggestion = { text: string; edit?: ConfigEdit };

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";

/** An image-px box as config CSS px, grown to whole pixels. */
function cssRect(r: IgnoreRect, scale: number): IgnoreRect {
  const x = Math.floor(r.x / scale);
  const y = Math.floor(r.y / scale);
  return {
    x,
    y,
    width: Math.ceil((r.x + r.width) / scale) - x,
    height: Math.ceil((r.y + r.height) / scale) - y,
  };
}

/** The stabilisation the config turned off, each as an edit that turns it back on. */
function stabilisation(config: CaptureConfig): Suggestion[] {
  const s = config.stabilise;
  const out: Suggestion[] = [];
  if (!s.animations)
    out.push({
      text: "Animations run during capture (`stabilise.animations` is off): turn it on so they jump to their end.",
      edit: { kind: "stabilise", key: "animations", value: true },
    });
  if (!s.caret)
    out.push({
      text: "The text caret is shown (`stabilise.caret` is off): turn it on to hide it.",
      edit: { kind: "stabilise", key: "caret", value: true },
    });
  if (s.clock === false)
    out.push({
      text: `The page sees the real clock (\`stabilise.clock\` is false): fix it at ${FIXED_CLOCK} so dates and timers render the same each run.`,
      edit: { kind: "stabilise", key: "clock", value: FIXED_CLOCK },
    });
  else if (!s.timers)
    out.push({
      text: "Page timers run during capture (`stabilise.timers` is off): turn it on so carousels and tickers stop where they start.",
      edit: { kind: "stabilise", key: "timers", value: true },
    });
  return out;
}

/**
 * What to change, most specific first and `flaky: "skip"` last. A story's route is not in the
 * config, so its ignore area and policy are said in words with no edit.
 */
export function suggestFixes(
  repro: Repro,
  config: CaptureConfig,
  route: Route,
  variant: Variant,
): Suggestion[] {
  if (repro.stable) return [];
  const story = route.storybook !== undefined;
  const out: Suggestion[] = [];
  const differing = repro.runs.filter((r) => r.differed);
  if (differing.some((r) => r.causes.includes("size"))) {
    const heights = [...new Set(repro.runs.map((r) => `${r.width}x${r.height}`))].join(", ");
    out.push({
      text: `The page's size changed between runs (${heights}): something arrives or grows after the page settles. Give it a fixed size (a min-height, an aspect ratio on images), or make it load before network idle.`,
    });
  }
  out.push(...stabilisation(config));
  if (repro.area) {
    const rect = cssRect(repro.area, config.stabilise.deviceScaleFactor);
    const where = `${rect.width}x${rect.height} at ${rect.x},${rect.y} (CSS px)`;
    const why = `The runs differ in one area, ${where}. If that is live content (a random or rotating element, an ad, a map), ignore it there`;
    out.push(
      story
        ? {
            text: `${why}: put \`data-pixelslash-ignore\` on the element in the story.`,
          }
        : {
            text: `${why}, for the ${variant.name} variant of ${route.name}. Better still, if you own the element, make it render the same (a seed for its randomness, fixed test data) or give it \`data-pixelslash-ignore\`.`,
            edit: { kind: "ignore", route: route.name, variant: variant.name, rect },
          },
    );
  }
  out.push(
    story
      ? {
          text: "Last resort: tag the story `pixelslash-flaky-skip`, so the server keeps its changes out of review. It is still captured.",
        }
      : {
          text: `Last resort: set \`flaky: "skip"\` on ${route.name}, so the server keeps its flaky changes out of review. It is still captured.`,
          edit: { kind: "flaky-skip", route: route.name },
        },
  );
  return out;
}

export type ReproReport = {
  title: string;
  repro: Repro;
  suggestions: Suggestion[];
  /** The runs' files, relative to the report, by run; and each differing run's overlay. */
  files: Record<number, string>;
  overlays: Record<number, string>;
};

/** Escaped text with its `backticked` spans as code. */
function withCode(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function regionLine(r: Region): string {
  const why = r.why ? `: ${r.why}` : "";
  return `${CAUSE_WORDS[r.kind]}, ${r.w}×${r.h} at ${r.x},${r.y} (${r.changedPixels} px${why})`;
}

function runFigure(run: ReproRun, file: string, overlay: string | undefined): string {
  const said =
    run.run === 1
      ? "run 1, the one the others are diffed against"
      : `run ${run.run}: ${run.differed ? "differed" : "same"}${run.causes.length > 0 ? ` (${run.causes.map((c) => CAUSE_WORDS[c]).join(", ")})` : ""}`;
  const diff = overlay ? `<a href="${esc(overlay)}">diff against run 1</a>` : "";
  const regions =
    run.regions.length > 0
      ? `<ul>${run.regions.map((r) => `<li>${esc(regionLine(r))}</li>`).join("")}</ul>`
      : "";
  return `<figure class="${run.differed ? "differed" : ""}"><img src="${esc(file)}" alt="${esc(said)}"><figcaption>${esc(said)} ${diff}${regions}</figcaption></figure>`;
}

/** The local report of one reproduction: the runs side by side, the verdict, and what to change. */
export function renderReproReport(input: ReproReport): string {
  const { repro, suggestions } = input;
  const n = repro.runs.length;
  const verdict = repro.stable
    ? `stable: all ${n} runs rendered the same`
    : `unstable: ${repro.differed.length} of ${n - 1} runs differed from run 1`;
  const figures = repro.runs
    .map((r) => runFigure(r, input.files[r.run] ?? "", input.overlays[r.run]))
    .join("");
  const fixes =
    suggestions.length === 0
      ? ""
      : `<section><h2>What to change</h2><ol>${suggestions.map((s) => `<li>${withCode(s.text)}${s.edit ? ' <span class="w">(<code>--write</code> can add this)</span>' : ""}</li>`).join("")}</ol></section>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PixelSlash flake: ${esc(input.title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { margin: 8px 0 0; color: #aaa; }
    section { padding: 24px; border-bottom: 1px solid #333; }
    a { color: #8ab4ff; }
    .stable { color: #4ade80; font-weight: 600; }
    .unstable { color: #ffd400; font-weight: 600; }
    .runs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
    figure { margin: 0; min-width: 0; }
    figure img { display: block; max-width: 100%; border: 1px solid #333; }
    figure.differed img { border-color: #ffd400; }
    figcaption { color: #aaa; margin-top: 4px; }
    figcaption ul { margin: 4px 0 0; padding-left: 18px; }
    .w { color: #888; }
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash flake: ${esc(input.title)}</h1>
    <p class="${repro.stable ? "stable" : "unstable"}">${esc(verdict)}</p>
    <p>Captured locally, each run diffed with run 1 under the shot's own diff options and ignore areas. Nothing was uploaded.</p>
  </header>
  <section><div class="runs">${figures}</div></section>
  ${fixes}
</body>
</html>
`;
}
