import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, test } from "vitest";
import { applyMigrations } from "./migrate";

const DRIZZLE = fileURLToPath(new URL("../../drizzle", import.meta.url));
const FILES = readdirSync(DRIZZLE)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "w",
          modules: true,
          script: "export default {}",
          d1Databases: { DB: "self-host-test", PARTIAL: "self-host-partial" },
        },
      ],
    }),
  );
  // workerd's cold start is spent here, not charged to the test's own 5 s.
  await mf.ready;
});
afterAll(() => mf?.dispose());

test("applies every migration once, records each as wrangler does, and none on a rerun", async () => {
  const db = await mf.getD1Database("DB");
  let batches = 0;
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === "batch") batches++;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await applyMigrations(counted, DRIZZLE)).toEqual(FILES);
  // one round trip for the whole history: a fallback to a batch per file would be 36 of them
  expect(batches).toBe(1);
  const rows = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
  expect(rows.results).toEqual(FILES.map((name) => ({ name })));
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orgs'")
    .all();
  expect(tables.results).toHaveLength(1);
  expect(await applyMigrations(db, DRIZZLE)).toEqual([]);
});

test("a migration that fails keeps the files before it recorded and leaves none of itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-partial-"));
  try {
    writeFileSync(join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
    writeFileSync(
      join(dir, "0002_bad.sql"),
      "CREATE TABLE c (id INTEGER);--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);",
    );
    const db = await mf.getD1Database("PARTIAL");
    await expect(applyMigrations(db, dir)).rejects.toThrow(/no_such_table/);
    const rows = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
    expect(rows.results).toEqual([{ name: "0001_a.sql" }]);
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a','c')")
      .all();
    expect(tables.results.map((t: { name: string }) => t.name).toSorted()).toEqual(["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
