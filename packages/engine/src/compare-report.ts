import type { Region } from "./regions.ts";
import { esc } from "./report.ts";

/** One snapshot in a `compare` of two snapshot dirs. */
export type CompareRow = {
  name: string;
  /** `chromium 1280x720 prefers: dark`: the rest of the identity; the scheme only when the compare varied it. */
  shot: string;
  /** Relative to the index; only a changed snapshot has a report. */
  report: string | undefined;
  changedPixels: number;
  /** The fingerprint fields that differ between Main and Branch; empty when they agree. */
  mismatch: string[];
  /** The manifest identity (`name / browser / WxH / theme`), for a caller that maps a row back to its shot. */
  key: string;
  /** What the diff found; empty unless the snapshot changed. */
  regions: Region[];
  /** Set when the shot was captured again and the captures disagreed (`check`, ob 1732). */
  flaky?: { runs: number; differed: number } | undefined;
};

function compareList(title: string, rows: CompareRow[], detail: (r: CompareRow) => string) {
  if (rows.length === 0) return "";
  const items = rows
    .map((r) => {
      const label = `${esc(r.name)} <span class="shot">${esc(r.shot)}</span>`;
      const link = r.report ? `<a href="${esc(r.report)}">${label}</a>` : label;
      return `<li>${link}${detail(r)}</li>`;
    })
    .join("\n");
  return `<section><h2>${esc(title)} (${rows.length})</h2>\n    <ul>\n      ${items}\n    </ul></section>`;
}

/**
 * The index of a `compare` of two snapshot dirs: counts, the fingerprint warning, and the lists.
 * `check` (ob 1732) adds its own title, a note on where the result was measured, and a link to the
 * flake report when a changed shot was captured again.
 */
export function renderCompareIndex(input: {
  changed: CompareRow[];
  unchanged: CompareRow[];
  added: CompareRow[];
  removed: CompareRow[];
  mismatched: CompareRow[];
  title?: string | undefined;
  note?: string | undefined;
  flakes?: string | undefined;
}): string {
  const { changed, unchanged, added, removed, mismatched } = input;
  const title = esc(input.title ?? "PixelSlash compare");
  const counts = `${changed.length} changed · ${unchanged.length} unchanged · ${added.length} new · ${removed.length} removed`;
  const warning =
    mismatched.length === 0
      ? ""
      : `<p class="warn">Main and Branch were rendered by different environments for ${mismatched.length} ${mismatched.length === 1 ? "snapshot" : "snapshots"}: ${esc(mismatched.map((r) => `${r.name} (${r.mismatch.join(", ")})`).join("; "))}. They were diffed anyway, so a font or browser change shows up as a change here; a server would ask for a re-baseline instead.</p>`;
  const note = input.note ? `<p>${esc(input.note)}</p>` : "";
  const flakes = input.flakes
    ? `<p>Changed shots were captured again: <a href="${esc(input.flakes)}">the flake report</a>.</p>`
    : "";
  const flaky = (r: CompareRow) =>
    r.flaky
      ? ` — <span class="warn">flaky: ${r.flaky.differed} of ${r.flaky.runs} captures differed</span>`
      : "";
  const px = (r: CompareRow) => ` — ${r.changedPixels} changed pixels${flaky(r)}`;
  const lists = [
    compareList("Changed", changed, px),
    compareList("New on Branch", added, () => ""),
    compareList("Removed from Branch", removed, () => ""),
    compareList("Unchanged", unchanged, () => ""),
  ].join("\n  ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 12px; }
    p { margin: 8px 0 0; color: #aaa; }
    .warn { color: #ffd400; }
    section { padding: 24px; border-bottom: 1px solid #333; }
    ul { margin: 0; padding: 0 0 0 20px; }
    li { margin: 0 0 8px; }
    .shot { color: #888; }
    a { color: #9cf; }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    ${note}
    ${warning}
    <p>${counts}</p>
    ${flakes}
  </header>
  ${lists}
</body>
</html>
`;
}
