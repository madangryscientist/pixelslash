import { esc } from "./report.ts";

/** One snapshot in a `compare` of two snapshot dirs. */
export type CompareRow = {
  name: string;
  /** `chromium 1280x720 light`: the rest of the identity. */
  shot: string;
  /** Relative to the index; only a changed snapshot has a report. */
  report: string | undefined;
  changedPixels: number;
  /** The fingerprint fields that differ between Main and Branch; empty when they agree. */
  mismatch: string[];
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

/** The index of a `compare` of two snapshot dirs: counts, the fingerprint warning, and the lists. */
export function renderCompareIndex(input: {
  changed: CompareRow[];
  unchanged: CompareRow[];
  added: CompareRow[];
  removed: CompareRow[];
  mismatched: CompareRow[];
}): string {
  const { changed, unchanged, added, removed, mismatched } = input;
  const counts = `${changed.length} changed · ${unchanged.length} unchanged · ${added.length} new · ${removed.length} removed`;
  const warning =
    mismatched.length === 0
      ? ""
      : `<p class="warn">Main and Branch were rendered by different environments for ${mismatched.length} ${mismatched.length === 1 ? "snapshot" : "snapshots"}: ${esc(mismatched.map((r) => `${r.name} (${r.mismatch.join(", ")})`).join("; "))}. They were diffed anyway, so a font or browser change shows up as a change here; a server would ask for a re-baseline instead.</p>`;
  const px = (r: CompareRow) => ` — ${r.changedPixels} changed pixels`;
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
  <title>PixelSlash compare</title>
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
    <h1>PixelSlash compare</h1>
    ${warning}
    <p>${counts}</p>
  </header>
  ${lists}
</body>
</html>
`;
}
