type Box = { w: number; h: number; kind: string };

/** Past this share of the compared area, the change boxes tint the thumbnail until it cannot be read. */
const WHOLE_SHOT_SHARE = 0.6;

/**
 * Whether the change boxes together cover most of the compared area. Their own area, not the
 * crop's: two small changes at the top and the bottom of a page make a crop of the whole page but
 * leave the thumbnail readable, so they keep the zoom and the highlight.
 */
export function coversMostOfShot(
  regions: Box[],
  compared: { width: number; height: number },
): boolean {
  const area = compared.width * compared.height;
  const changed = regions
    .filter((region) => region.kind === "change")
    .reduce((sum, region) => sum + region.w * region.h, 0);
  return area > 0 && changed / area >= WHOLE_SHOT_SHARE;
}

/** Every thumbnail box is 16:10 (PS-419), so cards in a row line up and a thin change is never a strip. */
export const THUMB_RATIO = 1.6;

type Window = { x: number; y: number; w: number; h: number };

/**
 * The window a thumbnail shows for a change's crop: a crop wider than the thumbnail's ratio grows
 * taller, centred on the change and kept inside the shot, so a thin wide change on a tall page
 * shows the page around it, not a strip of overlay. The crop's own maths (the report's
 * `changeCrop`) is not touched; only the window the box looks through changes. A crop that is
 * not wider than the box is left as it is.
 */
export function thumbWindow(crop: Window, shotHeight: number): Window {
  if (crop.w / crop.h <= THUMB_RATIO) return crop;
  const h = Math.min(shotHeight, crop.w / THUMB_RATIO);
  if (h <= crop.h) return crop;
  const y = Math.min(shotHeight - h, Math.max(0, crop.y + crop.h / 2 - h / 2));
  return { x: crop.x, y, w: crop.w, h };
}
