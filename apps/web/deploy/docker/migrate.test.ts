import { readdirSync } from "node:fs";
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
          d1Databases: { DB: "self-host-test" },
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
  expect(await applyMigrations(db, DRIZZLE)).toEqual(FILES);
  const rows = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
  expect(rows.results).toEqual(FILES.map((name) => ({ name })));
  const tables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orgs'")
    .all();
  expect(tables.results).toHaveLength(1);
  expect(await applyMigrations(db, DRIZZLE)).toEqual([]);
});
