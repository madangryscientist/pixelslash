import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { holdsChange } from "#/lib/snapshot-groups";
import { staleLine } from "#/lib/stale";
import { snapshots } from "./schema";
import { baselinePairs, markStale } from "./stale-apply";
import { projectStale, staleScope } from "./stale";
import { setTwinProject, twinsOfBuild } from "./twins";
import { type World, world } from "./twins-test-support";

/** The stale rule (PS-297): a native twin is stale from a web change a person accepted until a person accepts the native shot. */

let db: World["db"];
let userId: World["userId"];
let web: World["web"];
let native: World["native"];
let build: World["build"];
let idOf: World["idOf"];

beforeEach(async () => {
  ({ db, userId, web, native, build, idOf } = await world());
});

const CHANGED = { platform: "linux", diff: "changed", by: true } as const;
const keys = async (projectId: string, options?: Parameters<typeof projectStale>[2]) =>
  (await projectStale(db, projectId, options)).map((i) => `${i.name}/${i.theme}/${i.platform}`);

describe("projectStale: one project", () => {
  test("a changed web shot accepted by a person makes the android twin stale, with the cause", async () => {
    await build(web, 1, [{ platform: "android", diff: "unchanged", by: true }], { age: 60 });
    const w = await build(web, 2, [CHANGED], { age: 30 });
    const [item, ...rest] = await projectStale(db, web);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      name: "Button/primary",
      theme: "dark",
      platform: "android",
      cause: {
        snapshotId: await idOf(w, "Button/primary", "linux"),
        buildId: w,
        projectId: web,
        projectName: "web",
        acceptedBy: "ada",
      },
    });
    expect(item?.shots).toHaveLength(1);
    expect(staleLine(item!, "b-9")).toMatch(
      /^Button\/primary dark on android is stale: web changed in build b-9, accepted by ada \d{4}-\d\d-\d\d$/,
    );
  });

  test("a first baseline, an unchanged web shot or a pending change is not a cause", async () => {
    await build(web, 1, [{ platform: "android" }], { age: 60 });
    await build(web, 2, [{ platform: "linux", diff: "new", by: true }], { age: 40 });
    await build(web, 3, [{ platform: "linux", diff: "unchanged", by: true }], { age: 30 });
    await build(web, 4, [{ platform: "linux", diff: "changed" }], { age: 20 });
    await build(web, 5, [{ platform: "linux", diff: "changed", state: "accepted" }], { age: 10 });
    expect(await keys(web)).toEqual([]);
  });

  test("a native build with the shot unchanged leaves the twin stale, carried or not", async () => {
    await build(web, 1, [{ platform: "android", by: true }], { age: 60 });
    await build(web, 2, [CHANGED], { age: 30 });
    const carried = await build(web, 3, [{ platform: "android", diff: "changed" }], { age: 20 });
    await build(
      web,
      4,
      [
        { platform: "android", diff: "unchanged", state: "accepted" },
        {
          platform: "android",
          name: "Other",
          diff: "unchanged",
          by: true,
          carriedFrom: await idOf(carried, "Button/primary", "android"),
        },
      ],
      { age: 10 },
    );
    expect(await keys(web)).toEqual(["Button/primary/dark/android"]);
  });

  test("a person accepting a native shot of the key in a later native build ends it", async () => {
    await build(web, 1, [{ platform: "android", by: true }], { age: 60 });
    await build(web, 2, [CHANGED], { age: 30 });
    expect(await keys(web)).toEqual(["Button/primary/dark/android"]);
    await build(web, 3, [{ platform: "android", diff: "unchanged", by: true }], { age: 10 });
    expect(await keys(web)).toEqual([]);
  });

  test("a native accept made before the web change does not end it", async () => {
    await build(web, 1, [{ platform: "android", diff: "changed", by: true }], { age: 60 });
    await build(web, 2, [CHANGED], { age: 30 });
    expect(await keys(web)).toEqual(["Button/primary/dark/android"]);
  });

  test("a newer web change makes it stale again", async () => {
    await build(web, 1, [{ platform: "android", by: true }], { age: 90 });
    await build(web, 2, [CHANGED], { age: 70 });
    await build(web, 3, [{ platform: "android", diff: "unchanged", by: true }], { age: 50 });
    expect(await keys(web)).toEqual([]);
    const w = await build(web, 4, [CHANGED], { age: 20 });
    const [item] = await projectStale(db, web);
    expect(item?.cause.buildId).toBe(w);
  });

  test("each platform and key is its own: ios, another theme, a key with no native shot", async () => {
    await build(
      web,
      1,
      [
        { platform: "ios", by: true },
        { platform: "android", theme: "light", by: true },
      ],
      { age: 60 },
    );
    await build(web, 2, [CHANGED, { ...CHANGED, theme: "light" }, { ...CHANGED, name: "Alone" }], {
      age: 30,
    });
    expect(await keys(web)).toEqual(["Button/primary/dark/ios", "Button/primary/light/android"]);
    expect(await keys(web, { platform: "ios" })).toEqual(["Button/primary/dark/ios"]);
  });

  test("a web-only project has nothing stale, and no error", async () => {
    await build(web, 1, [CHANGED], { age: 30 });
    await build(web, 2, [{ platform: "linux", diff: "changed", by: true }], { age: 10 });
    expect(await projectStale(db, web)).toEqual([]);
    const empty = await world();
    expect(await projectStale(empty.db, empty.web)).toEqual([]);
  });
});

describe("projectStale: a linked twin project", () => {
  beforeEach(async () => {
    await setTwinProject(db, userId, web, native);
  });

  test("a web change makes the native project's twin stale, read from either project", async () => {
    await build(native, 1, [{ platform: "android", by: true }], { age: 60 });
    const w = await build(web, 2, [CHANGED], { age: 30 });
    for (const from of [web, native]) {
      const [item] = await projectStale(db, from);
      expect(item).toMatchObject({
        platform: "android",
        cause: { buildId: w, projectName: "web" },
      });
      expect(item?.shots[0]?.projectId).toBe(native);
    }
    expect(await keys(web, { crossProject: false })).toEqual([]);
  });

  test("an accept in the native project after the change ends it", async () => {
    await build(native, 1, [{ platform: "android", by: true }], { age: 60 });
    await build(web, 2, [CHANGED], { age: 30 });
    await build(native, 3, [{ platform: "android", diff: "unchanged", by: true }], { age: 10 });
    expect(await keys(native)).toEqual([]);
  });

  test("the build's twins section marks the stale twin, and the entry, with the cause", async () => {
    await build(native, 1, [{ platform: "android", by: true }], { age: 60 });
    const w = await build(web, 2, [CHANGED], { age: 30 });
    const twins = await twinsOfBuild(db, w);
    const entry = twins.linked.find((e) => e.platform === "web");
    expect(entry?.stale).toBeNull();
    expect(entry?.twins[0]?.stale).toMatchObject({ buildId: w, acceptedBy: "ada" });
  });
});

describe("markStale", () => {
  test("an unchanged native shot of a stale key carries the web snapshot, so it holds a change", async () => {
    await build(web, 1, [{ platform: "android", by: true }], { age: 60 });
    const w = await build(web, 2, [CHANGED], { age: 30 });
    const n = await build(
      web,
      3,
      [
        { platform: "android", diff: "unchanged" },
        { platform: "android", name: "Fresh", diff: "unchanged" },
      ],
      { age: 10 },
    );
    await markStale(db, n);
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, n));
    const stale = rows.find((r) => r.name === "Button/primary");
    const fresh = rows.find((r) => r.name === "Fresh");
    expect(stale?.staleOf).toBe(await idOf(w, "Button/primary", "linux"));
    expect(fresh?.staleOf).toBeNull();
    expect(
      holdsChange({ diffStatus: "unchanged", carriedFrom: null, staleOf: stale?.staleOf ?? null }),
    ).toBe(true);
    expect(holdsChange({ diffStatus: "unchanged", carriedFrom: null, staleOf: null })).toBe(false);
  });

  test("marking again after a person accepted the key clears it", async () => {
    await build(web, 1, [{ platform: "android", by: true }], { age: 60 });
    await build(web, 2, [CHANGED], { age: 30 });
    const n = await build(web, 3, [{ platform: "android", diff: "unchanged" }], { age: 10 });
    await markStale(db, n);
    const [row] = await db.select().from(snapshots).where(eq(snapshots.buildId, n));
    expect(row?.staleOf).not.toBeNull();
    await db
      .update(snapshots)
      .set({ reviewState: "accepted", reviewedBy: userId, reviewedAt: new Date() })
      .where(eq(snapshots.id, row!.id));
    await markStale(db, n);
    const [after] = await db.select().from(snapshots).where(eq(snapshots.buildId, n));
    expect(after?.staleOf).toBeNull();
  });

  test("a web-only build marks nothing", async () => {
    const b = await build(web, 1, [CHANGED]);
    await markStale(db, b);
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, b));
    expect(rows.every((r) => r.staleOf === null)).toBe(true);
  });
});

describe("baselinePairs", () => {
  test("pairs each accepted web baseline with the platform's, by name and theme", async () => {
    await build(web, 1, [
      { platform: "linux", state: "accepted", metrics: true },
      { platform: "android", state: "accepted", metrics: true },
      { platform: "linux", name: "Alone", state: "accepted" },
    ]);
    const scope = await staleScope(db, web);
    const pairs = await baselinePairs(db, scope, "android");
    expect(pairs.map((p) => [p.name, p.twins.map((t) => t.platform)])).toEqual([
      ["Button/primary", ["android"]],
    ]);
    expect(await baselinePairs(db, scope, "ios")).toEqual([]);
  });
});
