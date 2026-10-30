import { join } from "node:path";
import {
  GAP_COLOUR,
  GAP_LABEL,
  MAX_FINDINGS,
  SPECIAL_COLOUR,
  type Gap,
  type GapKind,
} from "./composition-entry.ts";
import type { IgnoreRect } from "./diff.ts";
import { esc } from "./report.ts";
import { CROP_CSS, slabStyle } from "./report-crop.ts";
import type { SnapshotManifest } from "./snapshot.ts";

/**
 * The gap list of a composition-only capture (ob 1850), as `gaps.json` and `gaps.html` beside the
 * manifest. The same classes or style on several shots is one group listing every place. A file,
 * never sent anywhere.
 */

/** Where a finding is: the shot (route + variant), the element, and its box in image px. */
export type Place = {
  name: string;
  variant: string;
  path: string;
  /** The shot's PNG, relative to the manifest's directory. */
  file: string;
  selector: string;
  tag: string;
  box: IgnoreRect;
};

/** One gap across every shot it appears on, with what the DOM showed that is not the library's. */
export type GapGroup = {
  kind: GapKind;
  classes: string[];
  style: string | null;
  reason: string;
  places: Place[];
};

export type SpecialPlace = Omit<Place, "tag"> & { reason: string };

/** `omitted`: findings past a shot's cap, summed over the shots; they are in no group. */
export type GapsList = {
  library: string;
  gaps: GapGroup[];
  special: SpecialPlace[];
  omitted: number;
};

/**
 * A one-line "not from <library>: ..." for a group, by kind. Only the DOM was read, so it says what
 * is on the element, not what the library lacks.
 */
function reason(library: string, g: Pick<Gap, "kind" | "classes" | "style">, tags: string[]) {
  const classes = `"${g.classes.join(" ")}"`;
  const tag = tags.map((t) => `<${t}>`).join("/");
  const style = g.style ? ` and "${g.style}"` : "";
  if (g.kind === "element") return `not from ${library}: the ${tag} styled ${classes}${style}`;
  if (g.kind === "class") return `not from ${library}: the classes ${classes}${style}`;
  return `not from ${library}: the inline style "${g.style ?? ""}"`;
}

/** Group a manifest's gaps by kind, classes and style, in first-seen order. */
export function gapsList(manifest: SnapshotManifest, library: string): GapsList {
  const groups = new Map<string, { gap: Gap; places: Place[] }>();
  const special: SpecialPlace[] = [];
  let omitted = 0;
  for (const e of manifest.snapshots) {
    if (!e.composition) continue;
    omitted += e.composition.omitted ?? 0;
    const at = { name: e.name, variant: e.variant.name, path: e.path, file: e.file };
    for (const g of e.composition.gaps) {
      const key = JSON.stringify([g.kind, g.classes.toSorted(), g.style]);
      const group = groups.get(key) ?? { gap: g, places: [] };
      group.places.push({ ...at, selector: g.selector, tag: g.tag, box: g.box });
      groups.set(key, group);
    }
    for (const s of e.composition.special) special.push({ ...at, ...s });
  }
  const gaps = [...groups.values()].map(({ gap, places }) => ({
    kind: gap.kind,
    classes: gap.classes,
    style: gap.style,
    reason: reason(library, gap, [...new Set(places.map((p) => p.tag))]),
    places,
  }));
  return { library, gaps, special, omitted };
}

/** Padding around a finding's box in its crop, in image px. */
const PAD = 16;

/** A crop is never blown up past this, so a three-pixel gap does not fill the page. */
const MAX_ZOOM = 6;

/** The widest a crop is drawn, in CSS px. */
const MAX_CROP_WIDTH = 480;

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(3)}%`;

/** The shot cropped to the box plus padding, CSS only (as the compare report does), the box outlined. */
function crop(src: string, size: { width: number; height: number }, box: IgnoreRect, cls: string) {
  const x = Math.max(0, box.x - PAD);
  const y = Math.max(0, box.y - PAD);
  const w = Math.min(size.width, box.x + box.width + PAD) - x;
  const h = Math.min(size.height, box.y + box.height + PAD) - y;
  const slab = slabStyle(size, { x, y, w, h });
  const mark = `left:${pct(box.x, size.width)};top:${pct(box.y, size.height)};width:${pct(box.width, size.width)};height:${pct(box.height, size.height)}`;
  return `<a class="crop" href="${esc(src)}" style="aspect-ratio:${w}/${h};max-width:${Math.min(MAX_CROP_WIDTH, w * MAX_ZOOM)}px"><span class="slab" style="${slab}"><img src="${esc(src)}" alt=""><span class="mark ${cls}" style="${mark}"></span></span></a>`;
}

type Sizes = Map<string, { width: number; height: number }>;

function where(p: Pick<Place, "name" | "variant" | "selector" | "box">) {
  const { x, y, width, height } = p.box;
  return `${esc(p.name)} <span class="shot">${esc(p.variant)}</span> <code>${esc(p.selector)}</code> <span class="shot">${width}×${height} at ${x},${y}</span>`;
}

function placeItem(p: Place | SpecialPlace, sizes: Sizes, cls: string, extra = "") {
  const size = sizes.get(p.file);
  const figure = size ? crop(p.file, size, p.box, cls) : "";
  return `<li>${where(p)}${extra}${figure}</li>`;
}

const none = (what: string) => `<p>No ${what}.</p>`;

/** `gaps.html`: the gap groups, then the special cases, each place cropped from its shot. */
export function renderGaps(list: GapsList, sizes: Sizes): string {
  const title = `${esc(list.library)} gaps`;
  const groups = list.gaps
    .map((g) => {
      const what = [
        g.classes.length > 0 ? `<code>${esc(g.classes.join(" "))}</code>` : "",
        g.style ? `<code>style="${esc(g.style)}"</code>` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const places = g.places.map((p) => placeItem(p, sizes, "gap")).join("\n        ");
      return `<li class="group"><p class="what">${GAP_LABEL[g.kind]}: ${what} — ${g.places.length} ${g.places.length === 1 ? "place" : "places"}</p>
      <p class="reason">${esc(g.reason)}</p>
      <ul>
        ${places}
      </ul></li>`;
    })
    .join("\n    ");
  const special = list.special
    .map((s) => placeItem(s, sizes, "special", ` — ${esc(s.reason)}`))
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; background: #111; color: #eee; }
    header, section { padding: 16px 24px; border-bottom: 1px solid #333; }
    h1 { font-size: 16px; font-weight: 600; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 12px; }
    p { margin: 8px 0 0; color: #aaa; }
    ul { margin: 0; padding: 0 0 0 20px; }
    li { margin: 0 0 12px; }
    .group > ul { margin-top: 8px; }
    .what { color: #eee; margin: 0; }
    .reason { color: #ffd400; margin: 4px 0 0; }
    .shot { color: #888; }
    code { color: #fc9; overflow-wrap: break-word; }
    a { color: #9cf; }
    ${CROP_CSS}
    .crop { margin-top: 6px; }
    .mark { position: absolute; box-sizing: border-box; outline: 2px solid; }
    .mark.gap { outline-color: ${GAP_COLOUR}; }
    .mark.special { outline: 2px dashed ${SPECIAL_COLOUR}; }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <p>${list.gaps.length} ${list.gaps.length === 1 ? "gap" : "gaps"} · ${list.special.length} special ${list.special.length === 1 ? "case" : "cases"}.${list.omitted > 0 ? ` ${list.omitted} more past the cap of ${MAX_FINDINGS} a shot were not kept.` : ""} Measured from the live DOM at capture; nothing was sent anywhere.</p>
  </header>
  <section><h2>${title} (${list.gaps.length})</h2>
    ${list.gaps.length === 0 ? none("gaps") : `<ul>\n    ${groups}\n    </ul>`}
  </section>
  <section><h2>Special cases (${list.special.length})</h2>
    ${list.special.length === 0 ? none("special cases") : `<ul>\n      ${special}\n    </ul>`}
  </section>
</body>
</html>
`;
}

/** A PNG's size from its IHDR chunk, without decoding it. */
async function pngSize(path: string) {
  const head = Buffer.from(await Bun.file(path).slice(0, 24).arrayBuffer());
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** Write `gaps.json` and `gaps.html` into the snapshot dir; returns the HTML's path. */
export async function writeGapsReport(
  out: string,
  manifest: SnapshotManifest,
  library: string,
): Promise<string> {
  const list = gapsList(manifest, library);
  const sizes: Sizes = new Map();
  for (const e of manifest.snapshots) sizes.set(e.file, await pngSize(join(out, e.file)));
  await Bun.write(join(out, "gaps.json"), `${JSON.stringify(list, null, 2)}\n`);
  const path = join(out, "gaps.html");
  await Bun.write(path, renderGaps(list, sizes));
  return path;
}
