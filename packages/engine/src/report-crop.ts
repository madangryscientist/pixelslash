import type { Region } from "./regions.ts";

/** The report's styles for the crop figures. */
export const CROP_CSS = `.cropnote { margin: 0 0 12px; }
    .crop { display: block; position: relative; overflow: hidden; background: #000; }
    .slab { position: absolute; }
    .slab img { height: 100%; image-rendering: pixelated; }
    summary { margin: 16px 0 12px; cursor: pointer; color: #9cf; }`;

/** Padding around the changed regions in the zoomed crop: the default `mergeDistance`, so the neighbours show. */
export const CROP_PADDING = 24;

/** A rectangle in image px, from the top-left of the shots. */
export type Crop = { x: number; y: number; w: number; h: number };

/**
 * The box the zoomed crop shows: the `change` regions' union plus padding, clipped to the overlap
 * of the two shots so the non-overlap is never drawn as changed. Noise and shift regions do not
 * make a shot changed, so they do not pull the crop; none left means nothing to zoom on.
 */
export function changeCrop(regions: Region[], overlapW: number, overlapH: number): Crop | null {
  const changed = regions.filter((r) => r.kind === "change");
  if (changed.length === 0) return null;
  const left = Math.max(0, Math.min(...changed.map((r) => r.x)) - CROP_PADDING);
  const top = Math.max(0, Math.min(...changed.map((r) => r.y)) - CROP_PADDING);
  const right = Math.min(overlapW, Math.max(...changed.map((r) => r.x + r.w)) + CROP_PADDING);
  const bottom = Math.min(overlapH, Math.max(...changed.map((r) => r.y + r.h)) + CROP_PADDING);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

const pct = (n: number) => `${n.toFixed(3)}%`;

/** The slab's style: the whole image `size`, offset and scaled so the window shows only `crop`. */
export function slabStyle(size: { width: number; height: number }, crop: Crop): string {
  return `left:${pct((-crop.x / crop.w) * 100)};top:${pct((-crop.y / crop.h) * 100)};width:${pct((size.width / crop.w) * 100)};height:${pct((size.height / crop.h) * 100)}`;
}

/**
 * One shot cropped to `crop` with CSS alone, so no new file is written: `inner` (the overlays,
 * positioned as percentages of the whole image) rides in a slab sized and offset like the full
 * image inside a window shaped like the crop. Scaled up, so the pixels stay crisp.
 */
export function cropFigure(
  shot: { label: "Main" | "Branch" | "Diff"; src: string; width: number; height: number },
  crop: Crop,
  inner: string,
): string {
  const slab = slabStyle(shot, crop);
  return `<figure><figcaption>${shot.label}</figcaption><a class="crop" href="${shot.src}" style="aspect-ratio:${crop.w}/${crop.h}"><span class="slab" style="${slab}"><img src="${shot.src}" alt="${shot.label} (changed region)">${inner}</span></a></figure>`;
}

/** How the ignore areas and the region boxes are drawn over a shot, and the region list under it. */
export const BOX_CSS = `.ignore { position: absolute; box-sizing: border-box; pointer-events: auto; border: 1px solid #5ec8ff; background: repeating-linear-gradient(45deg, rgba(94,200,255,.55) 0 3px, rgba(0,0,0,.35) 3px 7px); }
    .box { position: absolute; box-sizing: border-box; min-width: 6px; min-height: 6px; pointer-events: auto; }
    .box.change { border: 2px solid #ffd400; }
    .box.noise { border: 1px dashed #8a8a8a; }
    .box.shift { border: 2px dotted #4dd0e1; }
    .regions { margin: 12px 0 0; padding: 0 0 0 20px; color: #ccc; font-size: 12px; }
    .regions .noise { color: #888; }
    .regions .shift { color: #4dd0e1; }`;
