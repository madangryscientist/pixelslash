import { Buffer } from "node:buffer";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

/** The tests' `MODEL_KEY_SECRET`: base64 of 32 fixed bytes. Never a real secret. */
export const TEST_MODEL_KEY_SECRET = Buffer.alloc(32, 7).toString("base64");

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);

/**
 * An in-memory SQLite with the real migrations applied, behind the same async Drizzle API
 * D1 gives in production. Tests only: no network, no Cloudflare account. Runs under Bun (`bun --bun vitest`).
 * `beforeQuery` sees each statement before it runs and may run SQL of its own, to put a write
 * between a read and the write that follows it.
 */
export function testDb(beforeQuery?: (query: string, exec: (sql: string) => void) => void) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    for (const stmt of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      sqlite.exec(stmt);
    }
  }
  const one = (query: string, params: SQLInputValue[], method: string) => {
    beforeQuery?.(query, (sql) => sqlite.exec(sql));
    const stmt = sqlite.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  };
  return drizzle(
    async (query, params, method) => one(query, params, method),
    // A batch is one transaction, as D1's is: a statement that throws undoes the ones before it.
    async (queries) => {
      sqlite.exec("BEGIN");
      try {
        const out = queries.map((q) => one(q.sql, q.params, q.method));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  );
}
