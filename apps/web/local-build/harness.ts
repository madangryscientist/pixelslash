import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { inject } from "vitest";
import { members, orgs, projects, users } from "#/db/schema";
import { issueCiToken } from "#/db/tokens";
import { ROOT, STATE, WEB, run } from "./paths";

/**
 * What the local-build tests share: the server's URL and D1, one seed that gives a test its own org,
 * and the real CLI. The server itself is `server.ts`, the config's `globalSetup`.
 */

/** The server's URL, from the global setup. */
export const serverUrl = () => inject("localBuildUrl");

let sqlite: DatabaseSync | undefined;

/**
 * The server's D1 file behind the Drizzle API the app's queries use, so a test writes through the
 * app's own store functions (`revokeCiToken`, `setDiffLocation`), never raw SQL. SQLite's file lock
 * is what keeps it and the server's workerd apart, as it does for `wrangler d1 execute`.
 */
export function db() {
  if (!sqlite) {
    const dir = join(WEB, STATE, "v3/d1/miniflare-D1DatabaseObject");
    const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
    if (!file) throw new Error(`no D1 file under ${dir}`);
    sqlite = new DatabaseSync(join(dir, file));
  }
  const conn = sqlite;
  return drizzle(async (query, params, method) => {
    const stmt = conn.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

export type Seeded = {
  userId: string;
  orgId: string;
  projectId: string;
  tokenId: string;
  token: string;
};

/**
 * A user, an org with that user as its member, a project and a CI token. The org is synthetic
 * (`is_smoke = 1`) unless `real`. Ids carry a random suffix, so no two tests share a row; `fixedId`
 * uses that suffix instead and deletes the org and user first, so a rerun leaves one of each.
 */
export async function seed({
  real = false,
  fixedId,
}: { real?: boolean; fixedId?: string } = {}): Promise<Seeded> {
  const kind = real ? "real" : "synthetic";
  const suffix = fixedId ?? randomUUID().slice(0, 8);
  const ids = {
    userId: `${kind}-user-${suffix}`,
    orgId: `${kind}-org-${suffix}`,
    projectId: `${kind}-project-${suffix}`,
  };
  const d = db();
  if (fixedId !== undefined) {
    // The org's members, projects, tokens and builds go with it (ON DELETE CASCADE).
    await d.delete(orgs).where(eq(orgs.id, ids.orgId));
    await d.delete(users).where(eq(users.id, ids.userId));
  }
  await d.insert(users).values({ id: ids.userId, login: `${kind}-bot-${suffix}` });
  await d.insert(orgs).values({ id: ids.orgId, name: `${kind} ${suffix}`, isSmoke: !real });
  await d.insert(members).values({ orgId: ids.orgId, userId: ids.userId });
  await d
    .insert(projects)
    .values({ id: ids.projectId, orgId: ids.orgId, name: "web", diffLocation: "server" });
  const { id: tokenId, token } = await issueCiToken(d, ids.userId, ids.projectId, "ci");
  return { ...ids, tokenId, token };
}

/** Set the org's synthetic flag: a test's control for "would this count if the org were real". */
export async function setSynthetic(orgId: string, synthetic: boolean) {
  await db().update(orgs).set({ isSmoke: synthetic }).where(eq(orgs.id, orgId));
}

/** `wrangler` against the server's local state, from the app's directory; returns stdout. */
export function wrangler(...args: string[]) {
  return run(["x", "wrangler", ...args, "--local", "--env", "e2e", "--persist-to", STATE]);
}

/** The real CLI from source. A non-zero exit is a result, not a throw. */
export function cli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync("bun", [join(ROOT, "packages/cli/src/index.ts"), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** `pixelslash upload` to the server with a project's CI token. */
export function cliUpload(dir: string, token: string, branch = "local-build") {
  return cli(["upload", dir, "--server", serverUrl(), "--branch", branch], {
    PIXELSLASH_TOKEN: token,
  });
}

/** The CLI's stderr less its one `timing:` line (ob 1791): anything else on it is a warning. */
export function withoutTiming(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => !l.startsWith("timing: "))
    .join("\n");
}

/** The build id the CLI's upload prints. */
export const buildIdOf = (stdout: string) => /build: (\S+)/.exec(stdout)?.[1] ?? "";

const temps: string[] = [];

/** A temp dir removed by `removeTemps()`. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function removeTemps() {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}
