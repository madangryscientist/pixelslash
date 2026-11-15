import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";

/**
 * 0036 adds `projects.parent_project_id` and swaps the (org, name) unique index for one that
 * takes the parent in. It must not rebuild `projects`: on D1 a rebuild drops the table, and
 * `builds`, `snapshots` and the rest cascade away with it. Applied as `wrangler d1 migrations
 * apply` does it (one file, one batch), on a D1 already holding a project, a build and a shot.
 */

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const AT = FILES.findIndex((f) => f.startsWith("0036_"));

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

const count = async (db: D1Database, table: string) =>
  (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("migration 0036", () => {
  test("keeps a project, its build and its shot, and only adds the column and the index", async () => {
    const db = await d1();
    expect(AT).toBeGreaterThan(0);
    const sql = readFileSync(new URL(FILES[AT] ?? "", MIGRATIONS), "utf8");
    expect(sql).not.toMatch(/DROP TABLE|CREATE TABLE|RENAME/i);
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
    await apply(db, [FILES[AT] ?? ""]);

    expect([
      await count(db, "projects"),
      await count(db, "builds"),
      await count(db, "snapshots"),
    ]).toEqual([1, 1, 1]);
    const project = await db
      .prepare("SELECT name, parent_project_id FROM projects WHERE id = 'p1'")
      .first();
    expect(project).toEqual({ name: "web", parent_project_id: null });

    // A subproject may share a top-level project's name; two top-level ones, or two under one parent, may not.
    await db
      .prepare(
        "INSERT INTO projects (id, org_id, name, parent_project_id) VALUES ('p2', 'o1', 'web', 'p1')",
      )
      .run();
    const twice = (id: string, parent: string | null) =>
      db
        .prepare(
          "INSERT INTO projects (id, org_id, name, parent_project_id) VALUES (?, 'o1', 'web', ?)",
        )
        .bind(id, parent)
        .run();
    await expect(twice("p3", null)).rejects.toThrow(/UNIQUE/);
    await expect(twice("p4", "p1")).rejects.toThrow(/UNIQUE/);

    // A parent deleted takes its subprojects with it.
    await db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(await count(db, "projects")).toBe(0);
  }, 60_000);
});
