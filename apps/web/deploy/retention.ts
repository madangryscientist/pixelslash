/**
 * The retention sweep from the command line (PS-239), for a self-host: it reads the D1 and R2 state
 * Miniflare keeps on disk, prints what the sweep would delete and the bytes, and deletes only when
 * told to with `--apply`. A dry run is the default and reads nothing it does not list.
 *
 *   bun deploy/retention.ts --days 30                    # list what a 30-day window would delete
 *   bun deploy/retention.ts --days 30 --limit 100        # the oldest 100 only
 *   bun deploy/retention.ts --days 30 --apply            # delete it
 *
 * `--days` defaults to `PIXELSLASH_RETENTION_DAYS`; with neither it refuses, so retention is never
 * on by accident. `--persist-to` is the Miniflare state directory (`.../state/v3`), by default
 * `$PIXELSLASH_DATA_DIR/state/v3` (the Docker self-host) or `.wrangler/state/v3` (the LAN one). Stop
 * the server first when applying: a build uploaded while the sweep runs is its own risk, see
 * apps/web/README.md, "Retention". It needs the built Worker's `wrangler.json` for the database and
 * bucket names, the same as `serve.ts`.
 */
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import type { RetentionPlan } from "../src/db/retention.ts";
import { sweepRetention } from "../src/db/retention.ts";
import { formatBytes } from "../src/lib/format.ts";
import { retentionDaysOf, sweepSummary } from "../src/lib/retention.ts";
import { orgSweepBlobs, r2SweepStore } from "../src/storage/blobs.ts";
import { readConfig } from "./ssh/serve.ts";

const WEB_ROOT = resolve(import.meta.dirname, "..");

export type Args = { days: number; limit: number | undefined; apply: boolean; persistTo: string };

const USAGE =
  "usage: bun deploy/retention.ts [--days N] [--limit N] [--persist-to DIR] [--dry-run | --apply]";

/** A flag's value as a whole number above 0, or the message for it. */
function count(flag: string, raw: string): number {
  const found = retentionDaysOf(raw);
  if (found === undefined) throw new Error(`${flag} must be a whole number above 0, got ${raw}`);
  return found;
}

const VALUE_FLAGS = new Set(["--days", "--limit", "--persist-to"]);

/** The flags as typed: the ones that take a value, and `--apply` / `--dry-run`. */
function readFlags(argv: string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const rest = [...argv];
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    if (arg === "--apply" || arg === "--dry-run") switches.add(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const raw = rest.shift();
      if (raw === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      values.set(arg, raw);
    } else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  return { values, switches };
}

/** The Miniflare state directory: the flag, else the Docker self-host's data dir, else the LAN one's. */
function stateDir(flag: string | undefined, dataDir: string | undefined): string {
  if (flag) return resolve(flag);
  return dataDir ? join(dataDir, "state/v3") : join(WEB_ROOT, ".wrangler/state/v3");
}

/** The command line and environment as options; throws a message for anything it cannot take. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): Args {
  const { values, switches } = readFlags(argv);
  if (switches.has("--apply") && switches.has("--dry-run"))
    throw new Error("--apply and --dry-run contradict each other");
  const typedDays = values.get("--days");
  const days =
    typedDays === undefined
      ? retentionDaysOf(env["PIXELSLASH_RETENTION_DAYS"])
      : count("--days", typedDays);
  if (days === undefined)
    throw new Error(
      `retention is off: pass --days N or set PIXELSLASH_RETENTION_DAYS, nothing is swept without it\n${USAGE}`,
    );
  const typedLimit = values.get("--limit");
  return {
    days,
    limit: typedLimit === undefined ? undefined : count("--limit", typedLimit),
    apply: switches.has("--apply"),
    persistTo: stateDir(values.get("--persist-to"), env["PIXELSLASH_DATA_DIR"]),
  };
}

/** One line per build that would go (oldest first), then the totals. */
export function listing(plan: RetentionPlan): string[] {
  const lines = plan.expired.map((build) => {
    const bytes = build.blobs.reduce((sum, blob) => sum + blob.size, 0);
    const day = build.createdAt.toISOString().slice(0, 10);
    return `${build.id}  ${day}  ${build.branch}  ${build.blobs.length} blobs  ${formatBytes(bytes)}`;
  });
  const kept = plan.keptReferenced.length
    ? [`${plan.keptReferenced.length} past the window kept: a build that stays points at them`]
    : [];
  return [`cutoff ${plan.cutoff.toISOString()} (${plan.days} days)`, ...lines, ...kept];
}

/** Miniflare over the self-host's persisted state, with its D1 as `DB` and its R2 as `BLOBS`. */
function openState(persistTo: string): Miniflare {
  const config = readConfig();
  return new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.WARN),
      telemetry: { enabled: false },
      cf: false,
      resourcePersistencePath: persistTo,
      resourceTmpPath: join(persistTo, "../tmp"),
      workers: [
        {
          name: "pixelslash-retention",
          modules: true,
          script: "export default {}",
          compatibilityDate: config.compatibility_date,
          d1Databases: { DB: { id: config.d1_databases?.[0]?.["database_id"] ?? "" } },
          r2Buckets: { BLOBS: { id: config.r2_buckets?.[0]?.["bucket_name"] ?? "" } },
        },
      ],
    }),
  );
}

async function main(args: Args): Promise<void> {
  const mf = openState(args.persistTo);
  try {
    const store = r2SweepStore((await mf.getBindings<{ BLOBS: R2Bucket }>()).BLOBS);
    const db = drizzle(await mf.getD1Database("DB"));
    const { plan, result } = await sweepRetention(db, (orgId) => orgSweepBlobs(store, orgId), {
      days: args.days,
      now: new Date(),
      dryRun: !args.apply,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    for (const line of listing(plan)) process.stdout.write(`${line}\n`);
    process.stdout.write(`${sweepSummary(plan, result)}\n`);
    if (!args.apply && plan.expired.length) process.stdout.write("nothing deleted: pass --apply\n");
  } finally {
    await mf.dispose();
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(process.argv.slice(2), process.env));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
