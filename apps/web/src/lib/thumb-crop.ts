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
