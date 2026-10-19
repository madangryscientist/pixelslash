/** The side-by-side page of the cases where the two tools differ (ob 1477). */
import type { CorpusCase } from "./corpus.ts";
import { caseIou, locationDisagreements, verdictDisagreements } from "./score.ts";
import type { CaseResult, ToolResult } from "./types.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function figure(title: string, src: string | null, extra = ""): string {
  const body = src
    ? `<div class="shot"><img src="${esc(src)}" alt="${esc(title)}">${extra}</div>`
    : `<div class="none">no diff image<br>(unchanged)</div>`;
  return `<figure><figcaption>${esc(title)}</figcaption>${body}</figure>`;
}

function pngSize(png: Buffer): { w: number; h: number } {
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** A tool's diff (changed pixels on transparency) laid over a faded Branch shot, so it can be read. */
function diffFigure(title: string, c: CorpusCase, diffPng: Buffer | null, file: string): string {
  if (!diffPng) return figure(title, null);
  const { w, h } = pngSize(diffPng);
  const headWidth = (100 * c.width) / w;
  return `<figure><figcaption>${esc(title)}</figcaption><div class="shot over" style="aspect-ratio:${w}/${h}"><img class="under" src="../../corpus/${esc(c.name)}/head.png" style="width:${headWidth}%" alt=""><img src="${esc(file)}" alt="${esc(title)}"></div></figure>`;
}

function verdictWord(t: ToolResult | null): string {
  if (!t) return "not run";
  return t.changed ? "changed" : "same";
}

function chip(name: string, t: ToolResult | null, iou: number | null): string {
  const where = iou === null || !t?.changed ? "" : `, IoU ${iou.toFixed(2)}`;
  const cls = t?.changed ? "changed" : "same";
  return `<span class="chip ${cls}">${name}: ${verdictWord(t)}</span> <small>${esc(t?.note ?? "")}${where}</small>`;
}

function card(r: CaseResult): string {
  const c = r.case;
  const box = c.box;
  const gt = box
    ? `<div class="gt" style="left:${(100 * box.x) / c.width}%;top:${(100 * box.y) / c.height}%;width:${(100 * box.w) / c.width}%;height:${(100 * box.h) / c.height}%"></div>`
    : "";
  return `<section class="case">
  <h3>${esc(c.name)} <span class="label ${c.label}">${c.label}</span></h3>
  <p>${chip("PixelSlash", r.pixelslash, caseIou(r, "pixelslash"))} &nbsp; ${chip("Argos", r.argos, caseIou(r, "argos"))}</p>
  <div class="row">
    ${figure("Main (base)", `../../corpus/${c.name}/base.png`)}
    ${figure("Branch (head)" + (box ? ", green = ground truth" : ""), `../../corpus/${c.name}/head.png`, gt)}
    ${diffFigure("PixelSlash diff", c, r.pixelslash.diffPng, `diffs/${c.name}.pixelslash.png`)}
    ${diffFigure("Argos diff", c, r.argos?.diffPng ?? null, `diffs/${c.name}.argos.png`)}
  </div>
</section>`;
}

/** Which cases get a card, and in which section. */
export function disagreementCases(rows: CaseResult[]) {
  return { verdict: verdictDisagreements(rows), location: locationDisagreements(rows) };
}

function section(title: string, note: string, list: CaseResult[]): string {
  const cards = list.length === 0 ? "<p>None.</p>" : list.map((r) => card(r)).join("\n");
  return `<h2>${title} (${list.length})</h2><p class="note">${note}</p>${cards}`;
}

export function disagreementsHtml(rows: CaseResult[], date: string): string {
  const { verdict, location } = disagreementCases(rows);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PixelSlash vs Argos, ${date}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#18181b;background:#fafafa}
h1{margin:0 0 4px}h2{margin:32px 0 4px}h3{margin:0 0 4px;font-size:15px}.note{color:#52525b;margin:0 0 12px}
.case{background:#fff;border:1px solid #d4d4d8;border-radius:8px;padding:12px 14px;margin-bottom:16px}
.row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
figure{margin:0}figcaption{font-size:12px;color:#52525b;margin-bottom:2px}
.shot{position:relative;line-height:0}.shot img{width:100%;border:1px solid #d4d4d8;image-rendering:pixelated;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/12px 12px}
.over{position:relative}.over img{position:absolute;left:0;top:0}.over img.under{opacity:.3;border:0}.over img:not(.under){width:100%}
.gt{position:absolute;border:2px solid #16a34a;pointer-events:none}
.none{border:1px dashed #a1a1aa;color:#71717a;font-size:12px;text-align:center;padding:40px 8px}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-weight:600;font-size:12px}
.chip.changed{background:#fee2e2;color:#991b1b}.chip.same{background:#dcfce7;color:#166534}
.label{font-size:11px;font-weight:600;padding:1px 7px;border-radius:4px;vertical-align:middle}
.label.real{background:#dbeafe;color:#1e40af}.label.noise{background:#fef3c7;color:#92400e}.label.identical{background:#e4e4e7;color:#3f3f46}
</style></head><body>
<h1>PixelSlash vs Argos, ${date}</h1>
<p class="note">Red chip = the tool flagged the pair. Right answer: real flagged, noise and identical left alone. PixelSlash's diff is magenta and Argos's is red, each laid over a faded Branch shot.</p>
${section("Verdicts disagree", "One tool flagged the pair and the other did not.", verdict)}
${section("Same verdict, different place", "Real changes both tools flagged, but whose changed region differs by at least 0.30 IoU against the ground-truth box.", location)}
</body></html>
`;
}
