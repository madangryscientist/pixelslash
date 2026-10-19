import { stem, type Violation } from "./judge.ts";

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

export function renderPixelReport(input: {
  path?: string | undefined;
  changedPixels: number;
  main: { width: number; height: number };
  branch: { width: number; height: number };
}): string {
  const title = input.path ? `PixelSlash ${esc(input.path)}` : "PixelSlash";
  const count = input.path
    ? `${esc(input.path)} · ${input.changedPixels} changed pixels`
    : `${input.changedPixels} changed pixels`;
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
  </style>
</head>
<body>
  <header>
    <h1>PixelSlash</h1>
    <p>${count}</p>
    <p>${sizes}</p>
  </header>
  <section>
    <div class="row">
      <figure><figcaption>Main</figcaption><img src="main.png" alt="Main"></figure>
      <figure><figcaption>Branch</figcaption><img src="branch.png" alt="Branch"></figure>
      <figure><figcaption>Diff</figcaption><img src="diff.png" alt="Diff"></figure>
    </div>
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
