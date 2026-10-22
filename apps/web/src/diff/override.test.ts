import { parseConfig, resolveDiff } from "@pixelslash/engine";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { NotFoundError } from "#/db/db";
import { createOrg } from "#/db/orgs";
import { exportOverrides } from "#/db/override-export";
import { OverrideError, listOverrides, overrideChanges, saveOverride } from "#/db/overrides";
import { type DiffOptions, builds, projects, snapshots } from "#/db/schema";
import { diffOverrideChanges } from "#/db/schema-overrides";
import { signInGithubUser } from "#/db/users";
import { saveAndRediff } from "./override";
import { rerunShots } from "./rerun";
import { type Ctx, context, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** Diff thresholds set in the review UI (ob 1495). */

const white = shot();
/** A 6x6 change: 36 px, a change under the engine's defaults. */
const faint = shot({ blocks: [{ x: 8, y: 8, w: 6, h: 6, rgb: RED }] });

const VARIANT = { platform: "linux", browser: "chromium", viewport: "1280x720", theme: "light" };
const wholeTest = { name: "pricing", variant: null };
const variant = { name: "pricing", variant: VARIANT };

const deps = (ctx: Ctx) => ({ db: ctx.db, blobs: ctx.scoped });

/** Main with a white shot, then a branch build whose shot has a faint change. */
async function faintBranch(ctx: Ctx, diff: object = {}) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white, diff }] });
  return upload(ctx, {
    branch: "feat/x",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [{ png: faint, diff }],
  });
}

/** Each route's options as the CLI would upload them for the config's first variant. */
function configDiff(raw: object) {
  const parsed = parseConfig(raw);
  const [as] = parsed.variants;
  if (!as) throw new Error("no variant");
  return (name: string) => {
    const route = parsed.routes.find((r) => r.name === name);
    if (!route) throw new Error(`no route ${name}`);
    return resolveDiff(parsed, route, as);
  };
}

const changes = (ctx: Ctx) => ctx.db.select().from(diffOverrideChanges);

describe("review-UI diff overrides (ob 1495)", () => {
  test("saving re-diffs the open build: a faint change becomes unchanged and the build passes", async () => {
    const ctx = await context();
    const build = await faintBranch(ctx, { threshold: 0.1 });
    expect(build.status).toBe("changes");
    expect((await onlyShot(ctx, build)).diffStatus).toBe("changed");

    const saved = await saveAndRediff(deps(ctx), {
      userId: ctx.userId,
      build,
      target: wholeTest,
      options: { minChangedPixels: 100 },
    });
    expect(saved).toMatchObject({ changed: true, rediffed: 1, status: "passed", note: null });
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).status).toBe("passed");
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("unchanged");
    expect(row.resolvedDiff).toMatchObject({
      options: { threshold: 0.1, minChangedPixels: 100 },
      sources: {
        threshold: { from: "config" },
        minChangedPixels: { from: "ui", scope: "test", by: "ada" },
      },
    });
  });

  test("the UI beats the config, the variant beats the test, and a later build reads both", async () => {
    const ctx = await context();
    await faintBranch(ctx, { minChangedPixels: 100 });
    await saveOverride(ctx.db, ctx.userId, ctx.projectId, {
      ...wholeTest,
      options: { minChangedPixels: 1000 },
    });
    await saveOverride(ctx.db, ctx.userId, ctx.projectId, {
      ...variant,
      options: { minChangedPixels: 0 },
    });
    const later = await upload(ctx, {
      branch: "feat/y",
      commit: sha(3),
      mergeBase: sha(1),
      shots: [{ png: faint, diff: { minChangedPixels: 100 } }],
    });
    const row = await onlyShot(ctx, later);
    // Config says 100 (unchanged), the test's override 1000 (unchanged), the variant's 0: changed.
    expect(row.diffStatus).toBe("changed");
    expect(row.resolvedDiff?.options).toEqual({ minChangedPixels: 0 });
    expect(row.resolvedDiff?.sources.minChangedPixels).toMatchObject({
      from: "ui",
      scope: "variant",
    });
    expect(row.diffOptions).toEqual({ minChangedPixels: 100 });
  });

  test("clearing an override falls back to the config", async () => {
    const ctx = await context();
    const build = await faintBranch(ctx, { minChangedPixels: 100 });
    expect(build.status).toBe("passed");
    const set = { userId: ctx.userId, build, target: wholeTest };
    expect(
      await saveAndRediff(deps(ctx), { ...set, options: { minChangedPixels: 0 } }),
    ).toMatchObject({ status: "changes" });
    const cleared = await saveAndRediff(deps(ctx), {
      ...set,
      build: await getBuild(ctx.db, ctx.projectId, build.id),
      options: {},
    });
    expect(cleared).toMatchObject({ changed: true, rediffed: 1, status: "passed" });
    expect(await listOverrides(ctx.db, ctx.userId, ctx.projectId)).toEqual([]);
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("unchanged");
    expect(row.resolvedDiff?.sources).toEqual({ minChangedPixels: { from: "config" } });
  });

  test("an errored build re-run with a new override decides its shot again", async () => {
    const ctx = await context();
    const build = await faintBranch(ctx, { minChangedPixels: 100 });
    const shotRow = await onlyShot(ctx, build);
    await ctx.db
      .update(snapshots)
      .set({ reviewState: "accepted", reviewedBy: ctx.userId, reviewedAt: new Date() })
      .where(eq(snapshots.id, shotRow.id));
    await ctx.db.update(builds).set({ status: "errored" }).where(eq(builds.id, build.id));
    const errored = await getBuild(ctx.db, ctx.projectId, build.id);
    const saved = await saveAndRediff(deps(ctx), {
      userId: ctx.userId,
      build: errored,
      target: wholeTest,
      options: { minChangedPixels: 0 },
    });
    expect(saved).toMatchObject({ changed: true, rediffed: 0, status: "errored" });
    expect((await rerunShots(deps(ctx), errored, null)).status).toBe("changes");
    expect(await onlyShot(ctx, build)).toMatchObject({
      diffStatus: "changed",
      reviewState: "pending",
      reviewedBy: null,
    });
  });

  test("one audit row per change, and none for a save that changes nothing", async () => {
    const ctx = await context();
    const save = (options: DiffOptions) =>
      saveOverride(ctx.db, ctx.userId, ctx.projectId, { ...variant, options });
    expect(await save({ threshold: 0.2 })).toBe(true);
    expect(await save({ threshold: 0.2 })).toBe(false);
    expect(await save({ threshold: 0.3, minChangedRatio: 0.01 })).toBe(true);
    expect(await save({})).toBe(true);
    expect(await save({})).toBe(false);
    expect(await changes(ctx)).toHaveLength(3);
    const trail = await overrideChanges(ctx.db, ctx.userId, ctx.projectId);
    expect(trail.map((c) => [c.before, c.after])).toEqual([
      [{ threshold: 0.3, minChangedRatio: 0.01 }, null],
      [{ threshold: 0.2 }, { threshold: 0.3, minChangedRatio: 0.01 }],
      [null, { threshold: 0.2 }],
    ]);
    expect(trail.every((c) => c.by === "ada" && c.name === "pricing")).toBe(true);
    expect(trail[0]?.variant).toEqual(VARIANT);
  });

  test("a member of another org cannot read or write a project's overrides", async () => {
    const ctx = await context();
    await saveOverride(ctx.db, ctx.userId, ctx.projectId, {
      ...wholeTest,
      options: { threshold: 0.2 },
    });
    const eve = await signInGithubUser(ctx.db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await createOrg(ctx.db, eve.id, "Elsewhere");
    await expect(listOverrides(ctx.db, eve.id, ctx.projectId)).rejects.toThrow(NotFoundError);
    await expect(overrideChanges(ctx.db, eve.id, ctx.projectId)).rejects.toThrow(NotFoundError);
    await expect(
      saveOverride(ctx.db, eve.id, ctx.projectId, { ...wholeTest, options: { threshold: 0.9 } }),
    ).rejects.toThrow(NotFoundError);
    expect(await changes(ctx)).toHaveLength(1);
  });

  test("a CI project refuses an override: its diff is the CLI's", async () => {
    const ctx = await context();
    await ctx.db.update(projects).set({ diffLocation: "ci" }).where(eq(projects.id, ctx.projectId));
    await expect(
      saveOverride(ctx.db, ctx.userId, ctx.projectId, {
        ...wholeTest,
        options: { threshold: 0.2 },
      }),
    ).rejects.toThrow(OverrideError);
  });

  test("the export, uploaded instead of the overrides, gives the same verdicts", async () => {
    const config = {
      baseUrl: "http://localhost:3000",
      routes: [
        { path: "/pricing", name: "pricing", diff: { threshold: 0.1 } },
        { path: "/home", name: "home" },
      ],
    };
    const names = ["pricing", "home"];
    const baseShots = (diffOf: (name: string) => object) =>
      names.map((name) => ({ name, png: white, diff: diffOf(name) }));
    const branchShots = (diffOf: (name: string) => object) =>
      names.map((name) => ({ name, png: faint, diff: diffOf(name) }));

    // With overrides: pricing's test-wide minChangedPixels, home's variant one.
    const withUi = await context();
    const asUploaded = configDiff(config);
    await upload(withUi, { branch: "main", commit: sha(1), shots: baseShots(asUploaded) });
    const ui = { db: withUi.db, user: withUi.userId, project: withUi.projectId };
    await saveOverride(ui.db, ui.user, ui.project, {
      ...wholeTest,
      options: { minChangedPixels: 100 },
    });
    await saveOverride(ui.db, ui.user, ui.project, {
      name: "home",
      variant: VARIANT,
      options: { minChangedPixels: 100 },
    });
    const byUi = await upload(withUi, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: branchShots(asUploaded),
    });

    // Without: the export merged into the config.
    const exported = exportOverrides(await listOverrides(ui.db, ui.user, ui.project));
    const merged = {
      baseUrl: config.baseUrl,
      variants: exported.variants,
      routes: config.routes.map((r) => {
        const e = exported.routes.find((x) => x.name === r.name);
        return { ...r, diff: { ...r.diff, ...e?.diff }, variants: e?.variants };
      }),
    };
    const withConfig = await context();
    const asExported = configDiff(merged);
    await upload(withConfig, { branch: "main", commit: sha(1), shots: baseShots(asExported) });
    const byConfig = await upload(withConfig, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: branchShots(asExported),
    });

    const verdicts = async (ctx: Ctx, build: typeof byUi) =>
      (await rows(ctx, build))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((r) => [r.name, r.diffStatus, r.resolvedDiff?.options]);
    expect(byUi.status).toBe("passed");
    expect(byConfig.status).toBe(byUi.status);
    expect(await verdicts(withConfig, byConfig)).toEqual(await verdicts(withUi, byUi));
  });
});
