import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { memoryStore } from "#/api/test-support";
import { eq } from "drizzle-orm";
import { type Uploads, diffFinalised, sha, upload } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { orgBlobs } from "#/storage/blobs";
import { retryBusy } from "./busy";
import type { Build } from "./builds";
import type { Db } from "./db";
import { builds } from "./schema";
import { createOrg, createProject } from "./orgs";
import { d1Db } from "./test-d1";
import { signInGithubUser } from "./users";

/**
 * Rows written per uploaded build, as D1 counts them (`meta.rows_written`, which counts each index
 * entry a statement writes as a row). The hosted D1 is billed on that number, and one day of a
 * busy CI used the whole free tier, so a change that adds writes per shot fails here. The fixture
 * is fixed, so the numbers compare across runs; `apps/web/README.md`, "Rows written per build",
 * keeps them.
 */

type Tally = { rows: number; byStatement: Map<string, number> };

/** The statement's verb and table, and an update's first column, so a breakdown names what wrote. */
function label(sql: string): string {
  const flat = sql.replace(/\s+/g, " ").trim().toLowerCase();
  const verb = flat.match(/^(insert into|update|delete from) "?(\w+)"?/);
  if (!verb) return "other";
  const column = verb[1] === "update" ? flat.match(/ set "?(\w+)"?/)?.[1] : undefined;
  return [verb[1], verb[2], column && `(${column})`].filter(Boolean).join(" ");
}

/** What a counted statement wraps, read back when a batch sends it (through `retryBusy`'s proxy). */
const INNER = Symbol("counted statement");
type Inner = { statement: D1PreparedStatement; sql: string };
const isInner = (x: unknown): x is Inner => typeof x === "object" && x !== null && "sql" in x;
function inner(s: D1PreparedStatement): Inner | undefined {
  const found: unknown = Reflect.get(s, INNER);
  return isInner(found) ? found : undefined;
}

/**
 * The binding with every statement's `rows_written` added to `tally`. `raw()` returns no meta, so
 * a write sent through it (a `returning`) runs as `all()`, mapped to rows the way drizzle maps a
 * batch's results.
 */
function counting(d1: D1Database, tally: Tally): D1Database {
  const add = (sql: string, meta: { rows_written?: number } | undefined) => {
    const n = meta?.rows_written ?? 0;
    tally.rows += n;
    if (n) tally.byStatement.set(label(sql), (tally.byStatement.get(label(sql)) ?? 0) + n);
  };
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === INNER) return { statement: target, sql };
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === "run" || prop === "all")
          return async () => {
            const result = await target[prop]();
            add(sql, result.meta);
            return result;
          };
        if (prop === "raw")
          return async () => {
            if (/^\s*select/i.test(sql)) return target.raw();
            const result = await target.all();
            add(sql, result.meta);
            return result.results.map((row) => Object.values(row));
          };
        if (prop === "first") throw new Error("first() is not counted");
        const member = Reflect.get(target, prop, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    return proxy;
  };

  return new Proxy(d1, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (prop === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const found = statements.map(inner);
          const results = await target.batch(found.map((s, i) => s?.statement ?? statements[i]!));
          results.forEach((result, i) => add(found[i]?.sql ?? "batch", result.meta));
          return results;
        };
      const member = Reflect.get(target, prop, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

const SHOTS = 100;
const name = (i: number) => `s${String(i).padStart(3, "0")}`;
const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
/** Build (a): every shot new. */
const first = Array.from({ length: SHOTS }, (_, i) => ({ name: name(i), png: white }));
/** Builds (b) and (c): 50 unchanged, 40 changed, 10 new (and so 10 of (a)'s gone). */
const mix = [
  ...Array.from({ length: 50 }, (_, i) => ({ name: name(i), png: white })),
  ...Array.from({ length: 40 }, (_, i) => ({ name: name(50 + i), png: red })),
  ...Array.from({ length: 10 }, (_, i) => ({ name: `n${String(i).padStart(3, "0")}`, png: white })),
];

/** The diff's clock never moves, so a slow runner cannot run its budget out (as in d1-limits). */
const frozen = { now: () => 0 };

/**
 * The most rows each build may write, as measured. Before the cuts (`apps/web/README.md`, "Rows
 * written per build"): (a) 1,008, (b) 1,078, (c) 1,068. A change that raises one fails here; one
 * that lowers it lowers the number.
 */
const LIMIT = { a: 708, b: 768, c: 758 };

const tally: Tally = { rows: 0, byStatement: new Map() };
let held: { dispose: () => Promise<void> };
let ctx: Uploads;

beforeAll(async () => {
  const local = await d1Db();
  held = local;
  const db: Db = drizzle(retryBusy(counting(local.d1, tally)));
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, user.id, "Acme");
  const project = await createProject(db, user.id, org.id, { name: "web", diffLocation: "server" });
  ctx = { db, projectId: project.id, scoped: orgBlobs(memoryStore().store, org.id) };
}, 60_000);

afterAll(() => held?.dispose());

async function counted<T>(run: () => Promise<T>) {
  tally.rows = 0;
  tally.byStatement.clear();
  const value = await run();
  const breakdown = [...tally.byStatement].map(([k, v]) => `${k}: ${v}`).join(", ");
  return { value, rows: tally.rows, byStatement: new Map(tally.byStatement), breakdown };
}

async function measured(spec: Parameters<typeof upload>[1]) {
  const { value: build, ...rest } = await counted(() => upload(ctx, spec, frozen));
  return { build, ...rest };
}

/** Finalise a finished build again, as a retry of an errored one does: everything it holds stands. */
async function again(build: Build) {
  await ctx.db.update(builds).set({ status: "errored" }).where(eq(builds.id, build.id));
  return counted(() => diffFinalised(ctx, { ...build, status: "errored" }, frozen));
}

/** The rows written by updates of shot rows: what a run that changes nothing should send none of. */
const shotUpdates = (byStatement: Map<string, number>) =>
  [...byStatement].filter(([k]) => k.startsWith("update snapshots"));

let finished: { b: Build; c: Build } | undefined;

describe(`rows written per build of ${SHOTS} shots, on a local D1`, () => {
  test("each build writes no more rows than its limit", async () => {
    const a = await measured({ branch: "main", commit: sha(1), shots: first });
    expect(a.build.status).toBe("passed");
    const b = await measured({
      branch: "main",
      commit: sha(2),
      ancestors: [sha(1)],
      shots: mix,
    });
    expect(b.build.status).toBe("passed");
    const c = await measured({ branch: "feat", commit: sha(3), mergeBase: sha(1), shots: mix });
    expect(c.build.status).toBe("changes");
    process.stderr.write(
      `\nrows written per build (${SHOTS} shots):\n` +
        `  (a) first main build:  ${a.rows}  (${a.breakdown})\n` +
        `  (b) second main build: ${b.rows}  (${b.breakdown})\n` +
        `  (c) branch build:      ${c.rows}  (${c.breakdown})\n`,
    );
    // D1 reports the count locally: a zero would make every limit below pass for nothing.
    expect(a.rows).toBeGreaterThan(SHOTS);
    expect(a.rows).toBeLessThanOrEqual(LIMIT.a);
    expect(b.rows).toBeLessThanOrEqual(LIMIT.b);
    expect(c.rows).toBeLessThanOrEqual(LIMIT.c);
    finished = { b: b.build, c: c.build };
  }, 120_000);

  // The own diff, the diff against main, the open change carried from main, the default branch's
  // accept and the stale mark each write a shot only when its value moves.
  test("a build finalised again, with nothing moved, updates no shot row", async () => {
    if (!finished) throw new Error("the builds above did not finish");
    // A run drops its removed markers and writes them again (`clearMarkers`), so on the default
    // branch the 10 markers, new rows, are accepted again; no shot that was already accepted is.
    const expected = new Map([
      [finished.b, [["update snapshots (review_state)", 10]]],
      [finished.c, []],
    ]);
    for (const [build, writes] of expected) {
      const run = await again(build);
      expect(run.value.status).toBe(build.status);
      expect(shotUpdates(run.byStatement)).toEqual(writes);
    }
  }, 120_000);
});
