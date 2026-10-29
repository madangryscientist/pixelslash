import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, test } from "vitest";
import { getPlatformProxy } from "wrangler";
import { listOrgs } from "./orgs";
import { createSession, sessionUser, signInGithubUser, signInGoogleUser } from "./users";

/**
 * 0030 rebuilds `users` to let `github_id` be null (PS-274), which on D1 would cascade the drop
 * into every row that points at a user. Applied the way `wrangler d1 migrations apply` does it
 * (one file, one batch), on a D1 already holding a GitHub user, their session and membership.
 */

const MIGRATIONS = new URL("../../drizzle/", import.meta.url);
const CONFIG = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
const FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .toSorted();
const REBUILD = FILES.findIndex((f) => f.startsWith("0030_"));

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

describe("migration 0030", () => {
  test("applies on a fresh D1, and both sign-ins work after it", async () => {
    const db = await d1();
    await apply(db, FILES);
    const orm = drizzle(db);
    const user = await signInGoogleUser(orm, {
      sub: "g-1",
      email: "ada@example.com",
      name: null,
      avatarUrl: null,
    });
    const linked = await signInGithubUser(orm, {
      githubId: 1,
      login: "ada",
      name: null,
      avatarUrl: null,
      email: "ada@example.com",
    });
    expect(linked.id).toBe(user.id);
  }, 60_000);

  test("keeps a GitHub user's session, membership and invite, and they still sign in", async () => {
    const db = await d1();
    expect(REBUILD).toBeGreaterThan(0);
    await apply(db, FILES.slice(0, REBUILD));
    await db.batch([
      db.prepare(
        "INSERT INTO users (id, github_id, login, name) VALUES ('u1', 42, 'octo', 'Octo'), ('u2', 43, 'cat', NULL)",
      ),
      db.prepare("INSERT INTO orgs (id, name) VALUES ('o1', 'Acme')"),
      db.prepare("INSERT INTO members (org_id, user_id) VALUES ('o1', 'u1')"),
      db.prepare(
        "INSERT INTO invites (id, org_id, github_login, invited_by) VALUES ('i1', 'o1', 'cat', 'u1')",
      ),
    ]);
    // The cookie a signed-in user already holds; `sessions` is unchanged by 0030.
    const token = await createSession(drizzle(db), "u1");

    await apply(db, FILES.slice(REBUILD));

    expect(await count(db, "users")).toBe(2);
    expect(await count(db, "sessions")).toBe(1);
    expect(await count(db, "members")).toBe(1);
    expect(await count(db, "invites")).toBe(1);
    const orm = drizzle(db);
    expect((await sessionUser(orm, token))?.id).toBe("u1");

    const octo = await signInGithubUser(orm, {
      githubId: 42,
      login: "octo",
      name: "Octo",
      avatarUrl: null,
      email: "octo@example.com",
    });
    expect(octo).toMatchObject({ id: "u1", email: "octo@example.com", googleSub: null });
    expect((await listOrgs(orm, "u1")).map((o) => o.id)).toEqual(["o1"]);
    // The invite written before the rebuild still turns into a membership.
    await signInGithubUser(orm, { githubId: 43, login: "cat", name: null, avatarUrl: null });
    expect((await listOrgs(orm, "u2")).map((o) => o.id)).toEqual(["o1"]);
  }, 60_000);
});
