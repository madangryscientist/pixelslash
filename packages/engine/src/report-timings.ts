import { esc } from "./report.ts";
import type { Timings } from "./timings.ts";

/** Capture, then its parts (PS-195), then the steps after it. */
const STEP_KEYS = [
  "captureMs",
  "navigateMs",
  "settleMs",
  "screenshotMs",
  "diffMs",
  "judgeMs",
] as const;

const HEAD: Record<(typeof STEP_KEYS)[number], string> = {
  captureMs: "Capture",
  navigateMs: "Navigate",
  settleMs: "Settle",
  screenshotMs: "Screenshot",
  diffMs: "Diff",
  judgeMs: "Judge",
};

const SETTLE_HEAD = [
  ["fontsMs", "fonts"],
  ["imagesMs", "images"],
  ["networkIdleMs", "network idle"],
  ["framesMs", "frames"],
] as const;

/** The line under the table: the browser launch and the settle wait split by condition, run totals. */
function captureNote(t: Timings): string {
  const parts: string[] = [];
  if (t.browserLaunchMs !== undefined) parts.push(`browser launch ${t.browserLaunchMs} ms`);
  const settle = t.settle;
  if (settle)
    parts.push(`settle: ${SETTLE_HEAD.map(([k, label]) => `${label} ${settle[k]} ms`).join(", ")}`);
  // Pages are shot at once (a pair's two, up to four in `capture`): said only when the parts pass Capture.
  const partsMs = (t.navigateMs ?? 0) + (t.settleMs ?? 0) + (t.screenshotMs ?? 0);
  if (partsMs > (t.captureMs ?? 0))
    parts.push("pages shot at once overlap, so the parts exceed Capture");
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
