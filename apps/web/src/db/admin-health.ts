import { and, count, eq, gte, isNull, or, sql } from "drizzle-orm";
import { wallMs } from "#/lib/run-metrics";
import { type Reading, unavailable } from "#/lib/reading";
import { type StepStats, statsOf } from "#/lib/timings";
import { type Deployment, type DeploymentInputs, deploymentSection } from "./admin-deployment";
import { type NowHealth, isReal, nowSection } from "./admin-health-now";
import { type BuildCompares, BUILDS_SHOWN, buildCompares, ranCompare } from "./build-compares";
import { cacheHit } from "./cache-hit";
import type { Db } from "./db";
import { heldShot } from "./markers";
import { builds, detectionFlags, flakes, orgs, projects, snapshots } from "./schema";

/**
 * What the deployment is doing and how long it takes (PS-330), for the operator's health page.
 * Read-only, and every figure is a query: a figure nobody recorded, or that cannot be read, is a
 * `Reading` that says why, never a 0. Builds are the real ones (`real(orgs.isSmoke)`) and are not
 * split by org or customer. The page reads it as one call.
 */

const HOUR = 60 * 60 * 1000;
const HEALTH_WINDOWS = [
  { key: "24h", label: "Last 24 hours", ms: 24 * HOUR },
  { key: "7d", label: "Last 7 days", ms: 7 * 24 * HOUR },
] as const;

/** The most finished builds the windows read; a deployment with more is summarised on the newest. */
const HEALTH_MAX_BUILDS = 20_000;

const OUTCOME_KEYS = ["passed", "changes", "failed", "errored"] as const;
type Outcomes = { passed: number; changes: number; failed: number; errored: number };

type ErrorReason = { reason: string; count: number };

export type WindowHealth = {
  key: string;
  label: string;
  since: Date;
  /** Builds that finished a server step in the window (`finished_at`), the `n` of the outcomes. */
  finished: number;
  outcomes: Outcomes;
  /** Errored builds by the first words of their `error`; a build with none recorded says so. */
  errored: ErrorReason[];
  /** Builds a second run wrote the numbers of: in `finished`, left out of the times below. */
  rerun: number;
  /** `finished_at - created_at` over the builds that ran once. */
  wall: StepStats | null;
  queue: StepStats | null;
  diff: StepStats | null;
  explain: StepStats | null;
  summary: StepStats | null;
  /** Shots held by the builds that finished in the window, cache hits included. */
  snapshots: number;
  /** Shots of those builds compared by the server or by CI; a cache hit ran no compare. */
  comparesRun: number;
  /** Shots of those builds whose bytes matched their baseline. */
  cacheHits: number;
  /** Shots whose model explanation failed (`ai_error`) in those builds. */
  explainFailures: number;
  /** The newest builds of the window, up to `BUILDS_SHOWN`; `finished` is how many there were. */
  builds: BuildCompares[];
};

export type OperatorHealth = {
  asOf: Date;
  now: NowHealth;
  windows: WindowHealth[];
  /** The summary call's failures are not stored (a failed summary reads as none written). */
  summaryFailures: Reading<number>;
  /** Whether the window's rows were cut at `HEALTH_MAX_BUILDS`. */
  windowsCapped: boolean;
  deployment: Deployment;
  storage: {
    rows: { table: string; count: number }[];
    dbBytes: Reading<number>;
    r2: Reading<{ objects: number; bytes: number }>;
  };
};

export type HealthInputs = DeploymentInputs & {
  now: Date;
  /** The database's size, read by the caller from the binding (`meta.size_after`). */
  dbBytes: Reading<number>;
};

/** The first words of an error, up to its first sentence break: what groups errors that differ in detail. */
function errorReason(error: string | null): string {
  if (!error?.trim()) return "(no reason recorded)";
  const head = error.split(/[:;.\n]/)[0] ?? error;
  return head.trim().split(/\s+/).slice(0, 6).join(" ");
}

type FinishedRow = {
  id: string;
  status: string;
  error: string | null;
  createdAt: Date;
  finishedAt: Date;
  queueMs: number | null;
  diffMs: number | null;
  explainMs: number | null;
  summaryMs: number | null;
  rerun: boolean;
  /** False for an errored build that never wrote a finish (its run died): counted, not timed. */
  timed: boolean;
};

function windowOf(
  spec: (typeof HEALTH_WINDOWS)[number],
  now: Date,
  rows: FinishedRow[],
  shots: Pick<
    WindowHealth,
    "snapshots" | "comparesRun" | "cacheHits" | "explainFailures" | "builds"
  >,
): WindowHealth {
  const since = new Date(now.getTime() - spec.ms);
  const inside = rows.filter((r) => r.finishedAt >= since);
  const outcomes: Outcomes = { passed: 0, changes: 0, failed: 0, errored: 0 };
  const reasons = new Map<string, number>();
  for (const row of inside) {
    const outcome = OUTCOME_KEYS.find((key) => key === row.status);
    if (outcome) outcomes[outcome] += 1;
    if (row.status === "errored") {
      const reason = errorReason(row.error);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const once = inside.filter((r) => r.timed && !r.rerun);
  return {
    key: spec.key,
    label: spec.label,
    since,
    finished: inside.length,
    outcomes,
    errored: [...reasons]
      .map(([reason, n]) => ({ reason, count: n }))
      .toSorted((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    rerun: inside.filter((r) => r.rerun).length,
    wall: statsOf(once.map(wallMs)),
    queue: statsOf(once.map((r) => r.queueMs)),
    diff: statsOf(once.map((r) => r.diffMs)),
    explain: statsOf(once.map((r) => r.explainMs)),
    summary: statsOf(once.map((r) => r.summaryMs)),
    ...shots,
  };
}

/**
 * The builds that ended since `since`. A CI build whose run died is errored without a `finished_at`
 * (`heldElsewhere`), so it is placed by when its run started.
 */
const endedSince = (since: Date) =>
  or(
    gte(builds.finishedAt, since),
    and(
      eq(builds.status, "errored"),
      isNull(builds.finishedAt),
      gte(builds.processingStartedAt, since),
    ),
  );

/** The shots, compares, cache hits and failed explanations of the builds that ended since `since`. */
async function shotCounts(db: Db, since: Date) {
  const [row] = await db
    .select({
      held: sql<number>`sum(case when ${heldShot()} then 1 else 0 end)`,
      ran: sql<number>`sum(case when ${ranCompare()} then 1 else 0 end)`,
      hits: sql<number>`sum(${cacheHit()})`,
      failed: count(snapshots.aiError),
    })
    .from(snapshots)
    .innerJoin(builds, eq(builds.id, snapshots.buildId))
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(and(isReal(), endedSince(since)));
  return {
    snapshots: row?.held ?? 0,
    comparesRun: row?.ran ?? 0,
    cacheHits: row?.hits ?? 0,
    explainFailures: row?.failed ?? 0,
  };
}

/** The builds that ended in a window. One whose run died has no times (`timed: false`). */
async function windowsSection(db: Db, now: Date) {
  const widest = new Date(now.getTime() - Math.max(...HEALTH_WINDOWS.map((w) => w.ms)));
  const endedAt = sql`coalesce(${builds.finishedAt}, ${builds.processingStartedAt})`;
  const rows = await db
    .select({
      id: builds.id,
      status: builds.status,
      error: builds.error,
      createdAt: builds.createdAt,
      finishedAt: builds.finishedAt,
      processingStartedAt: builds.processingStartedAt,
      queueMs: builds.queueMs,
      diffMs: builds.diffMs,
      explainMs: builds.explainMs,
      summaryMs: builds.summaryMs,
      rerun: builds.rerun,
    })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .innerJoin(orgs, eq(orgs.id, projects.orgId))
    .where(and(isReal(), endedSince(widest)))
    .orderBy(sql`${endedAt} desc`)
    .limit(HEALTH_MAX_BUILDS);
  const finished: FinishedRow[] = [];
  for (const { processingStartedAt, ...row } of rows) {
    const ended = row.finishedAt ?? processingStartedAt;
    if (ended) finished.push({ ...row, finishedAt: ended, timed: row.finishedAt !== null });
  }
  // Newest first, so every window's newest builds are a prefix of these: one read serves them all.
  const newest = finished.slice(0, BUILDS_SHOWN);
  const compares = await buildCompares(db, newest);
  const windows: WindowHealth[] = [];
  for (const spec of HEALTH_WINDOWS) {
    const since = new Date(now.getTime() - spec.ms);
    const inWindow = new Set(newest.filter((r) => r.finishedAt >= since).map((r) => r.id));
    windows.push(
      windowOf(spec, now, finished, {
        ...(await shotCounts(db, since)),
        builds: compares.filter((b) => inWindow.has(b.id)),
      }),
    );
  }
  return { windows, capped: rows.length >= HEALTH_MAX_BUILDS };
}

async function storageSection(db: Db, input: HealthInputs): Promise<OperatorHealth["storage"]> {
  const rows = [];
  for (const [table, source] of [
    ["builds", builds],
    ["snapshots", snapshots],
    ["flakes", flakes],
    ["flags", detectionFlags],
  ] as const) {
    const [row] = await db.select({ n: count() }).from(source);
    rows.push({ table, count: row?.n ?? 0 });
  }
  return {
    rows,
    dbBytes: input.dbBytes,
    r2: unavailable(
      "R2 has no object or byte total to read cheaply; a count would list every object in the bucket",
    ),
  };
}

export async function operatorHealth(db: Db, input: HealthInputs): Promise<OperatorHealth> {
  const { windows, capped } = await windowsSection(db, input.now);
  return {
    asOf: input.now,
    now: await nowSection(db, input.now),
    windows,
    summaryFailures: unavailable(
      "a failed summary call is not recorded: it reads the same as a build that wrote none",
    ),
    windowsCapped: capped,
    deployment: await deploymentSection(db, input),
    storage: await storageSection(db, input),
  };
}
