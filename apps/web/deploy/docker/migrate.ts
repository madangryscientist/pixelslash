/**
 * The Docker self-host's D1 migrations (PS-240), applied at start without wrangler or Node in the
 * image. It keeps wrangler's own bookkeeping (`d1_migrations`, one row per file name), so
 * `wrangler d1 migrations apply DB --local --persist-to <data>/state` on the same volume agrees with
 * it and applies nothing twice. Files run in name order, each with its own row, and a migration that
 * fails leaves no half of itself behind. Migrations are additive (AGENTS.md).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** wrangler's table, column for column, so either can migrate the same database. */
const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** The statements of one drizzle migration file, which drizzle-kit separates with a breakpoint. */
const statementsOf = (sql: string): string[] =>
  sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

/** One migration's statements, then its bookkeeping row, for a single `db.batch`. */
const batchOf = (db: D1Database, dir: string, name: string): D1PreparedStatement[] => [
  ...statementsOf(readFileSync(join(dir, name), "utf8")).map((s) => db.prepare(s)),
  db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
];

/**
 * Apply every migration in `dir` that `db` has not recorded; returns the names applied.
 *
 * The pending files go in one batch, because each batch is a round trip to the database and a fresh
 * volume has dozens of files. A batch is one transaction, so when any file fails nothing from it is
 * kept; the files are then applied one batch each, in name order, which keeps every file before the
 * failing one recorded and throws the failing file's own error.
 */
export async function applyMigrations(db: D1Database, dir: string): Promise<string[]> {
  await db.prepare(BOOKKEEPING).run();
  const done = await db.prepare("SELECT name FROM d1_migrations").all<{ name: string }>();
  const applied = new Set(done.results.map((r) => r.name));
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .toSorted();
  if (pending.length === 0) return pending;
  try {
    await db.batch(pending.flatMap((name) => batchOf(db, dir, name)));
  } catch {
    for (const name of pending) await db.batch(batchOf(db, dir, name));
  }
  return pending;
}
