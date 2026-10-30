import type { IgnoreArea, IgnoreSource } from "#/components/snapshot-frame";
import type { DiffResult, IgnoreRect } from "#/db/schema";

const sameRect = (a: IgnoreRect, b: IgnoreRect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The areas to hatch on the viewer: the ones the diff skipped, as it stored them, and the box being
 * placed. A box drawn or cleared since this shot was measured changes nothing here until a re-diff;
 * a shot nothing measured shows only its own uploaded areas.
 */
export function ignoreAreas(
  snapshot: {
    ignore: IgnoreRect[];
    diffResult: Pick<DiffResult, "ignored"> | null;
    resolvedDiff: { ignore?: IgnoreRect[] | undefined } | null;
  },
  source: Exclude<IgnoreSource, "UI">,
  pending: IgnoreRect | null,
): IgnoreArea[] {
  const drawn = snapshot.resolvedDiff?.ignore ?? [];
  const skipped = snapshot.diffResult?.ignored ?? snapshot.ignore;
  return [
    ...skipped
      .filter((rect) => !drawn.some((box) => sameRect(box, rect)))
      .map((rect) => ({ rect, source })),
    ...(snapshot.diffResult ? drawn : []).map(({ x, y, width, height }) => ({
      rect: { x, y, width, height },
      source: "UI" as const,
    })),
    ...(pending ? [{ rect: pending, source: "UI" as const }] : []),
  ];
}
