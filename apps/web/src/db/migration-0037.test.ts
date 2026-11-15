import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";

/**
 * 0037 drops `snapshots_build_idx`, an index on `build_id` alone: the left prefix of the table's
 * unique index (build, name, platform, browser, viewport, theme), which serves every lookup by
 * build, so the extra index only cost a row written per shot. It must not rebuild `snapshots`.
 * Applied as `wrangler d1 migrations apply` does it (one file, one batch), on a D1 already
 * holding a project, a build and a shot.
 */

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const AT = FILES.findIndex((f) => f.startsWith("0037_"));

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => dispose?.());

async function d1(): Promise<D1Database> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: CONFIG, persist: false });
  dispose = () => proxy.dispose();
  return proxy.env.DB;
}

async function apply(db: D1Database, files: string[]): Promise<void> {
  for (const file of files) {
    const statements = readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim());
    await db.batch(statements.map((s) => db.prepare(s)));
  }
}

const indexes = async (db: D1Database) =>
  (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'snapshots' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((r) => r.name);

describe("migration 0037", () => {
  test("drops only the build index, keeps the shot, and a lookup by build still uses an index", async () => {
    const db = await d1();
    expect(AT).toBeGreaterThan(0);
    const sql = readFileSync(new URL(FILES[AT] ?? "", MIGRATIONS), "utf8");
    expect(sql.trim()).toBe("DROP INDEX `snapshots_build_idx`;");
    await apply(db, FILES.slice(0, AT));
    await db.batch([
      db.prepare("INSERT INTO orgs (id, name) VALUES ('o1', 'Acme')"),
      db.prepare("INSERT INTO projects (id, org_id, name) VALUES ('p1', 'o1', 'web')"),
      db.prepare(
        "INSERT INTO builds (id, project_id, commit_sha, branch) VALUES ('b1', 'p1', 'abc', 'main')",
      ),
      db.prepare(
        "INSERT INTO snapshots (id, build_id, name, platform, browser, viewport, theme, image_key, env_fingerprint) VALUES ('s1', 'b1', 'home', 'linux', 'chromium', '1280x720', 'light', 'k', '{}')",
      ),
    ]);
    const before = await indexes(db);
    await apply(db, [FILES[AT] ?? ""]);

    expect(before).toContain("snapshots_build_idx");
    expect(await indexes(db)).toEqual(before.filter((name) => name !== "snapshots_build_idx"));
    const shot = await db.prepare("SELECT id, name FROM snapshots WHERE build_id = 'b1'").first();
    expect(shot).toEqual({ id: "s1", name: "home" });

    const plan = await db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM snapshots WHERE build_id = ?")
      .bind("b1")
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toMatch(
      /SEARCH snapshots USING INDEX snapshots_build_id_name_platform_browser_viewport_theme_unique \(build_id=\?\)/,
    );
  }, 60_000);
});
