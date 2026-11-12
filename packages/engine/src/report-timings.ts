import { esc } from "./report.ts";
import type { Timings } from "./timings.ts";

/** Capture, then its parts (PS-195), then the steps after it. */
const STEP_KEYS = [
  "captureMs",
  "setupMs",
  "navigateMs",
  "settleMs",
  "storyMs",
  "screenshotMs",
  "measureMs",
  "diffMs",
  "judgeMs",
] as const;

const HEAD: Record<(typeof STEP_KEYS)[number], string> = {
  captureMs: "Capture",
  setupMs: "Setup",
  navigateMs: "Navigate",
  settleMs: "Settle",
  storyMs: "Story (in settle)",
  screenshotMs: "Screenshot",
  measureMs: "Measure",
  diffMs: "Diff",
  judgeMs: "Judge",
};

const SETTLE_HEAD = [
  ["fontsMs", "fonts"],
  ["imagesMs", "images"],
  ["networkIdleMs", "network"],
  ["framesMs", "frames"],
] as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The capture's wall clock against the workers' time added up, and over how many workers. */
function wallNote(t: Timings): string | undefined {
  if (t.captureWallMs === undefined) return undefined;
  const worker = t.captureMs === undefined ? "" : `, ${t.captureMs} ms of worker time`;
  const n = t.workers?.capture;
  const over = n === undefined ? "" : ` over ${plural(n, "worker", "workers")}`;
  return `capture wall ${t.captureWallMs} ms${worker}${over}`;
}

/** The machine the run was on, and how busy it was at each end. */
function hostNote({ host }: Timings): string | undefined {
  if (!host) return undefined;
  const { cores, loadStart, loadEnd } = host;
  return `host ${plural(cores, "core", "cores")}, load ${loadStart} at the start, ${loadEnd} at the end`;
}

/** The settle wait split by condition. */
function settleNote({ settle }: Timings): string | undefined {
  return settle
    ? `settle: ${SETTLE_HEAD.map(([k, label]) => `${label} ${settle[k]} ms`).join(", ")}`
    : undefined;
}

/** Pages are shot at once (a pair's two, several in `capture`): said only when the parts pass Capture. */
function overlapNote(t: Timings): string | undefined {
  const partsMs = (t.navigateMs ?? 0) + (t.settleMs ?? 0) + (t.screenshotMs ?? 0);
  return partsMs > (t.captureMs ?? 0)
    ? "pages shot at once overlap, so the parts exceed Capture"
    : undefined;
}

/** The line under the table: the browser launch, the capture's wall and workers, the host and the settle split, run totals. */
function captureNote(t: Timings): string {
  const parts = [
    t.browserLaunchMs === undefined ? undefined : `browser launch ${t.browserLaunchMs} ms`,
    wallNote(t),
    t.workers?.upload === undefined ? undefined : `upload workers ${t.workers.upload}`,
    hostNote(t),
    settleNote(t),
    overlapNote(t),
  ].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? "" : `\n    <p class="note">${esc(parts.join(" · "))}</p>`;
}

function cell(ms: number | undefined): string {
  return ms === undefined ? "" : `${ms} ms`;
}

const CSS = `.timings h2 { font-size: 14px; margin: 0 0 12px; }
    .timings table { border-collapse: collapse; font-size: 12px; }
    .timings th, .timings td { text-align: left; padding: 2px 16px 2px 0; color: #ccc; font-weight: normal; }
    .timings th { color: #aaa; }
    .timings tfoot td { border-top: 1px solid #333; }
    .timings .note { font-size: 12px; color: #aaa; margin: 8px 0 0; }`;

/**
 * The report's small timings table: one row per shot, slowest first, then the run's totals. It
 * carries its own style, so a report only has to place it.
 */
export function timingsTable(t: Timings): string {
  const cols = STEP_KEYS.filter((k) => t[k] !== undefined);
  const rows = t.shots
    .map(
      (s) =>
        `<tr><td>${esc(s.name)}</td>${cols.map((k) => `<td>${cell(s[k])}</td>`).join("")}</tr>`,
    )
    .join("\n        ");
  return `<style>${CSS}</style>
  <section class="timings"><h2>Timings</h2>
    <table>
      <thead><tr><th>Shot</th>${cols.map((k) => `<th>${HEAD[k]}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows}
      </tbody>
      <tfoot><tr><td>Total ${t.totalMs} ms</td>${cols.map((k) => `<td>${cell(t[k])}</td>`).join("")}</tr></tfoot>
    </table>${captureNote(t)}
  </section>`;
}

/** `html` with the timings table placed at the end of its body; `html` itself when there are none. */
export function withTimings(html: string, t: Timings | undefined): string {
  if (!t) return html;
  const at = html.lastIndexOf("</body>");
  return at < 0 ? html : `${html.slice(0, at)}${timingsTable(t)}\n${html.slice(at)}`;
}
