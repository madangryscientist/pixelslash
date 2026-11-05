import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { type Reading, ok, unavailable } from "#/lib/reading";
import type { Db } from "./db";

/** What this Worker is running against what the database has applied (PS-330). */

/** Wrangler's own bookkeeping table (`deploy/docker/migrate.ts` writes the same one); not in the app's schema. */
const d1Migrations = sqliteTable("d1_migrations", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export type DeploymentInputs = {
  /** The commit the running release is on, as the deploy stamped it; empty is not stamped. */
  releaseSha: string;
  /** The migration file names the code carries (`drizzle/*.sql`). */
  codeMigrations: readonly string[];
};

export type Deployment = {
  sha: Reading<string>;
  latestApplied: Reading<string>;
  /** Migrations in the code the database has not applied: the silent deploy break. */
  unapplied: Reading<string[]>;
};

export async function deploymentSection(db: Db, input: DeploymentInputs): Promise<Deployment> {
  const sha: Reading<string> = input.releaseSha
    ? ok(input.releaseSha)
    : unavailable("this deployment does not stamp SENTRY_RELEASE with its commit");
  let applied: string[] | null = null;
  let why = "";
  try {
    const rows = await db.select({ name: d1Migrations.name }).from(d1Migrations);
    applied = rows.map((r) => r.name);
  } catch (error) {
    why = `the database has no readable d1_migrations table (${error instanceof Error ? error.message : String(error)})`;
  }
  if (!applied)
    return {
      sha,
      latestApplied: unavailable(why),
      unapplied: unavailable(why),
    };
  const have = new Set(applied);
  const latest = applied.toSorted().at(-1);
  return {
    sha,
    latestApplied: latest ? ok(latest) : unavailable("the database has applied no migration"),
    unapplied: ok(input.codeMigrations.filter((m) => !have.has(m)).toSorted()),
  };
}
