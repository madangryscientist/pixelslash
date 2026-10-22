import { esc } from "./report.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import type { FlakyShot, SkippedShot } from "./flake-upload.ts";

function shotLabel(e: SnapshotEntry): string {
  const { width, height } = e.variant.viewport;
  return `${e.variant.browser} ${width}x${height} ${e.variant.theme}`;
}

function flakySection({ entry, record, files }: FlakyShot): string {
  const n = record.differed.length;
  const runs = [{ run: 1, file: entry.file }, ...files.map((file, i) => ({ run: i + 2, file }))];
  const figures = runs
    .map(({ run, file }) => {
      const differed = record.differed.includes(run);
      const caption = run === 1 ? "run 1 (uploaded)" : `run ${run}${differed ? " — differed" : ""}`;
      return `<figure><img src="${esc(file)}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
    })
    .join("");
  const regions = record.regions
    .flatMap(({ run, regions: found }) =>
      found.map(
        (r) => `<li>run ${run}: ${r.w}×${r.h} at ${r.x},${r.y} (${r.changedPixels} px)</li>`,
      ),
    )
    .join("");
  return `<section>
    <h2>${esc(entry.name)} <span class="shot">${esc(shotLabel(entry))}</span></h2>
    <p class="flaky">flaky: ${n} of ${record.runs} runs differed</p>
    <p>policy: <b>${esc(record.policy)}</b> — sent with the shot; what it does to the build is the server's call.</p>
    <div class="runs">${figures}</div>
    ${regions ? `<p>Where the runs differed from run 1, in image px:</p><ul>${regions}</ul>` : ""}
  </section>`;
}

function shotList(entries: { entry: SnapshotEntry; note?: string }[]): string {
  return entries
    .map(
      ({ entry, note }) =>
        `<li>${esc(entry.name)} <span class="shot">${esc(shotLabel(entry))}</span>${note ? ` — ${esc(note)}` : ""}</li>`,
    )
    .join("");
}

/** What the run can say when no shot was captured again, from what it measured. */
function nothingAgain(measured: number, shots: number): string {
  if (measured === 0)
    return "No shot was measured against a baseline here, so none was captured again.";
  const of = measured === shots ? `All ${shots}` : `${measured} of ${shots}`;
  return `${of} shots were measured against their baseline; none differed, so none was captured again.`;
}

export type FlakeReportInput = {
  flaky: FlakyShot[];
  changed: SnapshotEntry[];
  skipped: SkippedShot[];
  retries: number;
  /** Shots measured against a baseline, and shots in the dir. */
  measured: number;
  shots: number;
};

/**
 * The local report of an upload that re-captured its changed shots (ob 1737). "Flaky" means the
 * captures disagreed with each other; it says nothing about whether the change is wanted.
 */
export function renderFlakeReport(input: FlakeReportInput): string {
  const { flaky, changed, skipped, retries } = input;
  const counts = `${flaky.length} flaky · ${changed.length} changed in every run · ${skipped.length} not captured again · each changed shot captured ${retries} more ${retries === 1 ? "time" : "times"}`;
  const real =
    changed.length === 0
      ? ""
      : `<section><h2>Changed, every run agreed (${changed.length})</h2><ul>${shotList(changed.map((entry) => ({ entry })))}</ul></section>`;
  const unchecked =
    skipped.length === 0
      ? ""
      : `<section><h2>Changed, not captured again (${skipped.length})</h2><p>Uploaded as captured; whether they are flaky is unknown.</p><ul>${shotList(skipped.map(({ entry, why }) => ({ entry, note: why })))}</ul></section>`;
  const none =
    flaky.length + changed.length + skipped.length === 0
      ? `<section><p>${esc(nothingAgain(input.measured, input.shots))}</p></section>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PixelSlash upload</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 8px; }
    p { margin: 8px 0 0; color: #aaa; }
    section { padding: 24px; border-bottom: 1px solid #333; }
    ul { margin: 8px 0 0; padding: 0 0 0 20px; }
    .shot { color: #888; font-weight: 400; }
    .flaky { color: #ffd400; font-weight: 600; }
    .runs { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: 12px; }
    figure { margin: 0; min-width: 0; }
    figure img { display: block; max-width: 100%; border: 1px solid #333; }
    figcaption { color: #aaa; margin-top: 4px; }
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash upload</h1>
    <p>${counts}</p>
    <p>Flaky means the captures of one shot disagreed with each other. It says nothing about whether the change is wanted.</p>
  </header>
  ${flaky.map(flakySection).join("\n  ")}
  ${real}
  ${unchecked}
  ${none}
</body>
</html>
`;
}
