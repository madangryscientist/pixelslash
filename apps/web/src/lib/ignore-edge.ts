import type { DiffRegion, IgnoreRect } from "#/db/schema";

/**
 * The edge-touch warning (ob 1499): a changed region that touches an ignore area's edge may be
 * content that moved out of the area, which the area then hides half of. The diff skips the
 * pixels inside an area, so a region next to one stops at its edge; touching means sharing a
 * border or overlapping it, not merely being near.
 */

export const EDGE_WARNING = "content may have moved out of the ignored area";

/** Whether two rects overlap or share an edge (corners included). */
function touches(r: DiffRegion, a: IgnoreRect): boolean {
  return r.x <= a.x + a.width && a.x <= r.x + r.w && r.y <= a.y + a.height && a.y <= r.y + r.h;
}

/** Whether the region lies wholly inside the area: nothing of it is next to the area's outside. */
function inside(r: DiffRegion, a: IgnoreRect): boolean {
  return r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.width && r.y + r.h <= a.y + a.height;
}

/** The `change` regions that touch an ignore area's edge from outside it. */
export function edgeTouches(regions: DiffRegion[], areas: IgnoreRect[]): DiffRegion[] {
  return regions.filter(
    (r) => r.kind === "change" && areas.some((a) => touches(r, a) && !inside(r, a)),
  );
}
