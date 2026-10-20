import type { DiffOptions } from "./diff.ts";
import { describeDiffOptions } from "./diff-options.ts";
import { stem, type Violation } from "./judge.ts";
import type { Region, Specks } from "./regions.ts";

export type RouteRow = {
  path: string;
  slug: string;
  already: number;
  fresh: number;
  skipped: boolean;
  changedPixels: number;
};

function esc(s: string): string {
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

function regionLabel(r: Region, i: number): string {
  const what = r.kind === "noise" ? `noise (${r.why ?? "scattered"})` : "changed";
  return `#${i + 1} ${r.x},${r.y} ${r.w}x${r.h} · ${r.changedPixels} changed px · ${what}`;
}

function regionSummary(regions: Region[], specks: Specks): string {
  const changed = regions.filter((r) => r.kind === "change").length;
  const noise = regions.length - changed;
  const parts = [`${changed} changed ${changed === 1 ? "region" : "regions"}`];
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

export function renderPixelReport(input: {
  path?: string | undefined;
  changedPixels: number;
  /** The engine's verdict; false with a `change` region left means the diff floors held it back. */
  changed?: boolean;
  diff?: DiffOptions;
  regions: Region[];
  specks: Specks;
  main: { width: number; height: number };
  branch: { width: number; height: number };
}): string {
  const title = input.path ? `PixelSlash ${esc(input.path)}` : "PixelSlash";
  const count = input.path
    ? `${esc(input.path)} · ${input.changedPixels} changed pixels`
    : `${input.changedPixels} changed pixels`;
  const used = describeDiffOptions(input.diff ?? {});
  const options = used ? `<p>Diff options: ${esc(used)}</p>\n    ` : "";
  const floored =
    input.changed === false && input.regions.some((r) => r.kind === "change")
      ? `<p>Not changed: ${input.changedPixels} changed pixels are under the floors above.</p>\n    `
      : "";
  const diffWidth = Math.max(input.main.width, input.branch.width);
  const diffHeight = Math.max(input.main.height, input.branch.height);
  const sizes = `Main ${input.main.width}x${input.main.height} · Branch ${input.branch.width}x${input.branch.height}`;
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
    .box { position: absolute; box-sizing: border-box; min-width: 6px; min-height: 6px; pointer-events: auto; }
    .box.change { border: 2px solid #ffd400; }
    .box.noise { border: 1px dashed #8a8a8a; }
    .regions { margin: 12px 0 0; padding: 0 0 0 20px; color: #ccc; font-size: 12px; }
    .regions .noise { color: #888; }
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash</h1>
    <p>${count}</p>
    ${options}${floored}
    <p>${esc(regionSummary(input.regions, input.specks))}</p>
    <p>${sizes}</p>
  </header>
  <section>
    <div class="row">
      <figure><figcaption>Main</figcaption><img src="main.png" alt="Main"></figure>
      <figure><figcaption>Branch</figcaption><img src="branch.png" alt="Branch"></figure>
      <figure><figcaption>Diff</figcaption><div class="frame"><img src="diff.png" alt="Diff">${regionBoxes(input.regions, diffWidth, diffHeight)}</div></figure>
    </div>
    ${regionList(input.regions)}
  </section>
</body>
</html>
`;
}

function routeStatus(r: RouteRow, pixel: boolean): string {
  if (pixel) return `${r.changedPixels} changed pixels`;
  if (r.skipped) return "skip: no judge";
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
    <p>${input.already.length} already on Main · ${input.fresh.length} new on Branch</p>
  </header>
  ${shots}
  ${rasters}
  ${renderViolations("Already on Main", input.already, "No violations on Main.", "already")}
  ${renderViolations("New on Branch", input.fresh, "No new violations", "new")}
</body>
</html>
`;
}
