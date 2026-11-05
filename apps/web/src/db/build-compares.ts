import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { cliCompareMs } from "#/lib/run-metrics";
import { P99_MIN_COMPARES, type StepStats, gatedStats, statsOf } from "#/lib/timings";
import { cacheHit } from "./cache-hit";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, snapshots } from "./schema";

/**
 * One build's snapshots and the times of its compares (PS-336), for the operator page. Computed in
 * SQL over `snapshots_build_idx`, one query for the whole list: the database holds too many shots
 * to bring into JS, and D1 is billed and limited per query.
 */

/** The most builds one list of the page shows. It is also what bounds the rows these queries read. */
export const BUILDS_SHOWN = 50;

export type BuildCompares = {
  id: string;
  status: string;
  /** Shots the build holds, cache hits included; a removed marker is none. */
  snapshots: number;
  /** Of those, the ones compared, by the server or by CI. */
  compared: number;
  cacheHits: number;
  /** Over the compares the server timed, or else the ones the CLI sent; null when neither did. */
  times: StepStats | null;
};

const held = () => sql`case when ${heldShot()} then 1 else 0 end`;

/**
 * The build card's compares, by the server or by CI: a shot holding a result, measured by someone,
 * and no cache hit. A re-run clears the result and leaves who measured it.
 */
export const ranCompare = () =>
  sql`snapshots.diff_status in ('changed', 'unchanged') and snapshots.measured_by is not null and not ${cacheHit()}`;

/**
 * The value at a nearest-rank percentile of a ranked sample: `ceil(pct/100 · n)`, in integers because
 * SQLite has no `ceil` everywhere. The same rank as `percentile` in `lib/timings.ts`.
 */
const atRank = (pct: number) =>
  sql<number>`max(case when rn = (${sql.raw(String(pct))} * n + 99) / 100 then ms end)`;

async function timesByBuild(db: Db, ids: string[]): Promise<Map<string, StepStats>> {
  const ranked = db
    .select({
      buildId: snapshots.buildId,
      ms: sql<number>`snapshots.diff_ms`.as("ms"),
      rn: sql<number>`row_number() over (partition by snapshots.build_id order by snapshots.diff_ms)`.as(
        "rn",
      ),
      n: sql<number>`count(*) over (partition by snapshots.build_id)`.as("n"),
    })
    .from(snapshots)
    .where(
      and(
        inArray(snapshots.buildId, ids),
        eq(snapshots.measuredBy, "server"),
        isNotNull(snapshots.diffMs),
        ranCompare(),
      ),
    )
    .as("ranked");
  const rows = await db
    .select({
      buildId: ranked.buildId,
      p50: atRank(50),
      p95: atRank(95),
      p99: atRank(99),
      max: sql<number>`max(ms)`,
      n: sql<number>`max(n)`,
    })
    .from(ranked)
    .groupBy(ranked.buildId);
  return new Map(rows.map(({ buildId, ...r }) => [buildId, gatedStats(r, P99_MIN_COMPARES)]));
}

/** What the CLI sent per shot, for a build that diffed on the runner: the card's fallback too. */
async function cliTimes(db: Db, ids: string[]): Promise<Map<string, StepStats>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: builds.id, timings: builds.timings })
    .from(builds)
    .where(inArray(builds.id, ids));
  return new Map(
    rows.flatMap(({ id, timings }) => {
      const stats = statsOf((timings?.shots ?? []).map(cliCompareMs), P99_MIN_COMPARES);
      return stats ? [[id, stats] as const] : [];
    }),
  );
}

/** What each of `list` holds and how long its compares took, in the order given. */
export async function buildCompares(
  db: Db,
  list: readonly { id: string; status: string }[],
): Promise<BuildCompares[]> {
  if (list.length === 0) return [];
  const ids = list.map((b) => b.id);
  const counted = await db
    .select({
      buildId: snapshots.buildId,
      snapshots: sql<number>`sum(${held()})`,
      compared: sql<number>`sum(case when ${ranCompare()} then 1 else 0 end)`,
      cacheHits: sql<number>`sum(${cacheHit()})`,
    })
    .from(snapshots)
    .where(inArray(snapshots.buildId, ids))
    .groupBy(snapshots.buildId);
  const counts = new Map(counted.map((c) => [c.buildId, c]));
  const server = await timesByBuild(db, ids);
  const cli = await cliTimes(
    db,
    ids.filter((id) => (counts.get(id)?.compared ?? 0) > 0 && !server.has(id)),
  );
  return list.map(({ id, status }) => {
    const c = counts.get(id);
    return {
      id,
      status,
      snapshots: c?.snapshots ?? 0,
      compared: c?.compared ?? 0,
      cacheHits: c?.cacheHits ?? 0,
      times: server.get(id) ?? cli.get(id) ?? null,
    };
  });
}
