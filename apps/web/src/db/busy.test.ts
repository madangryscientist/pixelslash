import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryStore } from "#/api/test-support";
import { type Uploads, onlyShot, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { orgBlobs } from "#/storage/blobs";
import { retryBusy } from "./busy";
import type { Db } from "./db";
import { createOrg, createProject } from "./orgs";
import { d1Db } from "./test-d1";
import { signInGithubUser } from "./users";

/**
 * A deploy migrating the self-host's D1 holds its write lock, and SQLite answers SQLITE_BUSY (PS-228).
 * Runs on a local D1 (miniflare), with the lock stood in for by a binding that throws it.
 */

let held: Awaited<ReturnType<typeof d1Db>>;
let ctx: Uploads;

beforeAll(async () => {
  held = await d1Db();
  const user = await signInGithubUser(held.db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(held.db, user.id, "Acme");
  const project = await createProject(held.db, user.id, org.id, {
    name: "web",
    diffLocation: "server",
  });
  ctx = { db: held.db, projectId: project.id, scoped: orgBlobs(memoryStore().store, org.id) };
}, 60_000);

afterAll(() => held?.dispose());

/** The binding, but a statement whose SQL matches `sql` throws SQLITE_BUSY its first `times` runs. */
function locked(d1: D1Database, sql: RegExp, times: number) {
  const state = { left: times, tries: 0 };
  const statement = (inner: D1PreparedStatement, hit: boolean): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, prop) {
        if (prop === "bind") return (...v: unknown[]) => statement(target.bind(...v), hit);
        const member = Reflect.get(target, prop, target);
        if (typeof member !== "function") return member;
        if (!hit || !["run", "all", "raw", "first"].includes(String(prop)))
          return member.bind(target);
        return async (...args: unknown[]) => {
          state.tries++;
          if (state.left-- > 0) throw new Error("D1_ERROR: database is locked: SQLITE_BUSY");
          return member.apply(target, args);
        };
      },
    });
  const binding = new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare")
        return (query: string) => statement(target.prepare(query), sql.test(query));
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { binding, state };
}

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
// The write the repro failed on: a shot's resolved diff, stored when the run starts measuring it.
const RESOLVED = /update "snapshots" set .*"resolved_diff"/;

describe("a D1 write that meets the lock (PS-228)", () => {
  test("busy twice, then free: the diff completes", async () => {
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const { binding, state } = locked(held.d1, RESOLVED, 2);
    const db: Db = drizzle(retryBusy(binding));

    const build = await upload(
      ctx,
      { branch: "feat/a", commit: sha(2), mergeBase: sha(1), shots: [{ png: red }] },
      { db },
    );

    expect(build).toMatchObject({ status: "changes", error: null });
    expect(await onlyShot(ctx, build)).toMatchObject({ diffStatus: "changed" });
    expect(state.tries).toBeGreaterThanOrEqual(3);
  });

  test("busy for good: the build ends errored and names the lock", async () => {
    const { binding, state } = locked(held.d1, RESOLVED, Infinity);
    const db: Db = drizzle(retryBusy(binding));

    const build = await upload(
      ctx,
      { branch: "feat/b", commit: sha(3), mergeBase: sha(1), shots: [{ png: red }] },
      { db },
    );

    expect(build.status).toBe("errored");
    expect(build.error).toMatch(/SQLITE_BUSY/);
    // Bounded: the first try and one more after each of the four waits.
    expect(state.tries).toBe(5);
  });

  test("an error that is not a lock is not tried again", async () => {
    let tries = 0;
    const fake = {
      prepare: () => ({
        all: async () => {
          tries++;
          throw new Error("no such table: nope");
        },
      }),
    };
    // oxlint-disable-next-line no-unsafe-type-assertion -- a fake with only the members under test
    const d1 = fake as unknown as D1Database;
    await expect(retryBusy(d1).prepare("select 1").all()).rejects.toThrow(/no such table/);
    expect(tries).toBe(1);
  });
});
