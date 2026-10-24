import type { DiffOptions, IgnoreRect } from "./diff.ts";
import { IDENTICAL_NOTE, identicalBody } from "./identical-note.ts";
import { describeDiffOptions } from "./diff-options.ts";
import { stem, type Violation } from "./judge.ts";
import type { Region, Specks } from "./regions.ts";
import { BOX_CSS, changeCrop, CROP_CSS, CROP_PADDING, cropFigure } from "./report-crop.ts";

export type RouteRow = {
  path: string;
  slug: string;
  already: number;
  fresh: number;
  skipped: boolean;
  skipReason?: string | undefined;
  changedPixels: number;
};

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderViolations(title: string, items: Violation[], empty: string, cls: string): string {
  if (items.length === 0)
    return `<section class="${cls}"><h2>${esc(title)}</h2><p class="empty">${esc(empty)}</p></section>`;
  const body = items
    .map((v) => `<article><h3>${esc(v.component)}</h3><p>${esc(v.reason)}</p></article>`)
    .join("\n");
  return `<section class="${cls}"><h2>${esc(title)}</h2>${body}</section>`;
}

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(3)}%`;

/** The region boxes, as outlines positioned over a figure of `width` x `height` pixels. */
function regionBoxes(regions: Region[], width: number, height: number): string {
  return regions
    .map((r, i) => {
      const style = `left:${pct(r.x, width)};top:${pct(r.y, height)};width:${pct(r.w, width)};height:${pct(r.h, height)}`;
      return `<span class="box ${r.kind}" style="${style}" title="${esc(regionLabel(r, i))}"></span>`;
    })
    .join("");
}

/**
 * The ignore areas, hatched over a figure of `width` x `height` pixels. They were not measured,
 * so they are drawn as neither changed nor unchanged: a pattern over the real pixels.
 */
function ignoreBoxes(ignored: IgnoreRect[], width: number, height: number): string {
  return ignored
    .map((r) => {
      const style = `left:${pct(r.x, width)};top:${pct(r.y, height)};width:${pct(r.width, width)};height:${pct(r.height, height)}`;
      return `<span class="ignore" style="${style}" title="ignored ${r.x},${r.y} ${r.width}x${r.height}"></span>`;
    })
    .join("");
}

function regionLabel(r: Region, i: number): string {
  const what = {
    noise: `noise (${r.why ?? "scattered"})`,
    shift: `shifted (${r.why ?? "moved alike"})`,
    change: "changed",
  }[r.kind];
  return `#${i + 1} ${r.x},${r.y} ${r.w}x${r.h} · ${r.changedPixels} changed px · ${what}`;
}

function regionSummary(regions: Region[], specks: Specks): string {
  const changed = regions.filter((r) => r.kind === "change").length;
  const noise = regions.filter((r) => r.kind === "noise").length;
  const shifted = regions.filter((r) => r.kind === "shift").length;
  const parts = [`${changed} changed ${changed === 1 ? "region" : "regions"}`];
  if (shifted > 0) parts.push(`${shifted} shifted`);
  if (noise > 0) parts.push(`${noise} noise`);
  if (specks.count > 0)
    parts.push(`${specks.count} ${specks.count === 1 ? "speck" : "specks"} dropped`);
  return parts.join(" · ");
}

function regionList(regions: Region[]): string {
  if (regions.length === 0) return "";
  const items = regions
    .map((r, i) => `<li class="${r.kind}">${esc(regionLabel(r, i))}</li>`)
    .join("");
  return `<ol class="regions">${items}</ol>`;
}

type Notes = { options: string; floored: string; ignoredLine: string };

/** The one line that says an area was not measured; empty when nothing was skipped. */
function ignoredNote(pixels: number, areas: number): string {
  if (pixels === 0) return "";
  const px = `${pixels} ignored ${pixels === 1 ? "pixel" : "pixels"}`;
  const where = `${areas} ${areas === 1 ? "area" : "areas"}`;
  return `<p>${px} in ${where} (hatched): not measured, neither changed nor unchanged.</p>\n    `;
}

/** The optional header paragraphs: diff options, the floors note and the ignored-pixel count. */
function headerNotes(input: {
  changedPixels: number;
  changed?: boolean | undefined;
  diff?: DiffOptions | undefined;
  regions: Region[];
  ignoredPixels?: number | undefined;
  ignored?: IgnoreRect[] | undefined;
}): Notes {
  const used = describeDiffOptions(input.diff ?? {});
  const held = input.changed === false && input.regions.some((r) => r.kind === "change");
  return {
    options: used ? `<p>Diff options: ${esc(used)}</p>\n    ` : "",
    floored: held
      ? `<p>Not changed: ${input.changedPixels} changed pixels are under the floors above.</p>\n    `
      : "",
    ignoredLine: ignoredNote(input.ignoredPixels ?? 0, input.ignored?.length ?? 0),
  };
}

/** The figures of a pixel report: the changed region zoomed with the full frame behind a click, or just the full frame. */
function reportBody(input: Parameters<typeof renderPixelReport>[0], ignored: IgnoreRect[]): string {
  const { main, branch } = input;
  const diff = {
    width: Math.max(main.width, branch.width),
    height: Math.max(main.height, branch.height),
  };
  const fullFrame = `<div class="row">
      <figure><figcaption>Main</figcaption><div class="frame"><img src="main.png" alt="Main">${ignoreBoxes(ignored, main.width, main.height)}</div></figure>
      <figure><figcaption>Branch</figcaption><div class="frame"><img src="branch.png" alt="Branch">${ignoreBoxes(ignored, branch.width, branch.height)}</div></figure>
      <figure><figcaption>Diff</figcaption><div class="frame"><img src="diff.png" alt="Diff">${ignoreBoxes(ignored, diff.width, diff.height)}${regionBoxes(input.regions, diff.width, diff.height)}</div></figure>
    </div>`;
  const list = regionList(input.regions);
  const crop = changeCrop(
    input.regions,
    Math.min(main.width, branch.width),
    Math.min(main.height, branch.height),
  );
  if (!crop) return fullFrame + list;
  const mainShot = { label: "Main", src: "main.png", ...main } as const;
  const branchShot = { label: "Branch", src: "branch.png", ...branch } as const;
  const diffShot = { label: "Diff", src: "diff.png", ...diff } as const;
  const diffOver =
    ignoreBoxes(ignored, diff.width, diff.height) +
    regionBoxes(input.regions, diff.width, diff.height);
  return `<p class="cropnote">Changed region ${crop.x},${crop.y} ${crop.w}x${crop.h} (changed regions plus ${CROP_PADDING}px), scaled up. Click a crop for the full image.</p>
    <div class="row">
      ${cropFigure(mainShot, crop, ignoreBoxes(ignored, main.width, main.height))}
      ${cropFigure(branchShot, crop, ignoreBoxes(ignored, branch.width, branch.height))}
      ${cropFigure(diffShot, crop, diffOver)}
    </div>
    ${list}
    <details><summary>Full frame</summary>
    ${fullFrame}
    </details>`;
}

export function renderPixelReport(input: {
  path?: string | undefined;
  changedPixels: number;
  /** The engine's verdict; false with a `change` region left means the diff floors held it back. */
  changed?: boolean;
  diff?: DiffOptions;
  regions: Region[];
  specks: Specks;
  /** Pixels inside an ignore area; left out of every count above. */
  ignoredPixels?: number;
  /** The ignore areas, clipped to the overlap, in image px. */
  ignored?: IgnoreRect[];
  /** `identical-bytes`: both shots were the same file, nothing was decoded or diffed (ob 1948). */
  settledBy?: "identical-bytes" | undefined;
  main: { width: number; height: number };
  branch: { width: number; height: number };
}): string {
  const title = input.path ? `PixelSlash ${esc(input.path)}` : "PixelSlash";
  const identical = input.settledBy === "identical-bytes";
  const result = identical ? IDENTICAL_NOTE : `${input.changedPixels} changed pixels`;
  const count = input.path ? `${esc(input.path)} · ${result}` : result;
  const ignored = input.ignored ?? [];
  const notes = headerNotes(input);
  const sizes = `Main ${input.main.width}x${input.main.height} · Branch ${input.branch.width}x${input.branch.height}`;
  const body = identical ? identicalBody() : reportBody(input, ignored);
  const summary = identical ? "" : `<p>${esc(regionSummary(input.regions, input.specks))}</p>`;
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
    p { margin: 8px 0 0; color: #aaa; }
    section { padding: 24px; }
    .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    figure { margin: 0; background: #1a1a1a; padding: 8px; }
    figcaption { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #aaa; margin-bottom: 6px; }
    img { display: block; width: 100%; height: auto; background: #000; }
    .frame { position: relative; }
    ${CROP_CSS}
    ${BOX_CSS}
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash</h1>
    <p>${count}</p>
    ${identical ? "" : notes.options}${notes.floored}
    ${summary}
    <p>${sizes}</p>
    ${notes.ignoredLine}
  </header>
  <section>
    ${body}
  </section>
</body>
</html>
`;
}

function routeStatus(r: RouteRow, pixel: boolean): string {
  if (pixel) return `${r.changedPixels} changed pixels`;
  if (r.skipped) return `skip: ${r.skipReason ?? "no judge"}`;
  return `${r.already} already on Main · ${r.fresh} new on Branch`;
}

export function renderIndex(rows: RouteRow[], pixel: boolean): string {
  const items = rows
    .map((r) => {
      const status = routeStatus(r, pixel);
      return `<li><a href="${esc(r.slug)}/report.html">${esc(r.path)}</a> — ${esc(status)}</li>`;
    })
    .join("\n");
  const already = rows.reduce((n, r) => n + r.already, 0);
  const fresh = rows.reduce((n, r) => n + r.fresh, 0);
  const total = rows.reduce((n, r) => n + r.changedPixels, 0);
  const summary = pixel
    ? `${rows.length} routes · ${total} changed pixels`
    : `${rows.length} routes · ${already} already on Main · ${fresh} new on Branch`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PixelSlash</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    p { margin: 8px 0 0; color: #aaa; }
    section { padding: 24px; }
    ul { margin: 0; padding: 0 0 0 20px; }
    li { margin: 0 0 8px; }
    a { color: #9cf; }
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash</h1>
    <p>${summary}</p>
  </header>
  <section>
    <ul>
      ${items}
    </ul>
  </section>
</body>
</html>
`;
}

export function renderReport(input: {
  already: Violation[];
  fresh: Violation[];
  components: string[];
  /** Set when the judge did not run: the report says so instead of claiming no violations. */
  skipReason?: string | undefined;
}): string {
  const shots = `<section><h2>Pages</h2>
    <div class="pair">
      <figure><figcaption>Main</figcaption><img src="live.png" alt="Main"></figure>
      <figure><figcaption>Branch</figcaption><img src="local.png" alt="Branch"></figure>
    </div></section>`;
  const rasters = `<section><h2>Design system</h2>
    <div class="row">${input.components
      .map(
        (n) =>
          `<figure><figcaption>${esc(stem(n))}</figcaption><img src="ds/${esc(n)}" alt="${esc(stem(n))}"></figure>`,
      )
      .join("")}</div></section>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PixelSlash</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 12px; }
    h3 { font-size: 13px; margin: 0 0 4px; }
    p { margin: 8px 0 0; color: #aaa; }
    section { padding: 24px; border-bottom: 1px solid #333; }
    .empty { color: #8c8; }
    .new h2 { color: #f88; }
    article { margin: 0 0 12px; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
    figure { margin: 0; background: #1a1a1a; padding: 8px; }
    figcaption { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #aaa; margin-bottom: 6px; }
    img { display: block; width: 100%; height: auto; background: #000; }
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash</h1>
    <p>${input.skipReason ? `skip: ${esc(input.skipReason)} · nothing was judged` : `${input.already.length} already on Main · ${input.fresh.length} new on Branch`}</p>
  </header>
  ${shots}
  ${rasters}
  ${input.skipReason ? "" : renderViolations("Already on Main", input.already, "No violations on Main.", "already")}
  ${input.skipReason ? "" : renderViolations("New on Branch", input.fresh, "No new violations", "new")}
</body>
</html>
`;
}
