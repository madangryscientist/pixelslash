import { sql } from "drizzle-orm";

/**
 * A shot whose bytes matched its baseline (PS-336): the server read nothing and ran no compare, so
 * it is counted as a shot and left out of every compare count and time. Stored rows say so three
 * ways: a hash equal to the baseline's, the 0 ms `timedComparer` wrote on this path until PS-336
 * (rows are not rewritten), or, for a hit older than the timing, the hash with a null time. CI is
 * no hit on the same bytes: the CLI has no such shortcut, it fetched the baseline and compared. Written
 * with the table's own name because a query without a join would leave a Drizzle column unqualified,
 * and inside the subquery that would read the baseline's row. Always 0 or 1, never NULL.
 */
export const cacheHit = () =>
  sql<boolean>`coalesce(snapshots.measured_by is not 'ci' and snapshots.diff_status = 'unchanged' and (snapshots.diff_ms = 0 or snapshots.image_sha256 = (select baseline.image_sha256 from snapshots as baseline where baseline.id = snapshots.baseline_snapshot_id)), 0)`.mapWith(
    Boolean,
  );
