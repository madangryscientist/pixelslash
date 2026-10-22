import { type IgnoreRect, parseConfig } from "@pixelslash/engine";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { getBuild } from "#/db/builds";
import { NotFoundError } from "#/db/db";
import {
  addIgnoreBox,
  clearIgnoreBox,
  listIgnoreBoxes,
  uploadedIgnoreSource,
} from "#/db/ignore-boxes";
import { createOrg } from "#/db/orgs";
import { exportOverrides } from "#/db/override-export";
import { OverrideError } from "#/db/overrides";
import { projects } from "#/db/schema";
import { resolveIgnore } from "../../../../packages/engine/src/config.ts";
import { signInGithubUser } from "#/db/users";
import { addBoxAndRediff, clearBoxAndRediff } from "./ignore-box";
import { type Ctx, context, onlyShot, rows, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/** Ignore boxes drawn in the review UI (ob 1499). */

const white = shot();
/** A 10x10 change at (20,10): a change under the engine's defaults. */
const changed = shot({ blocks: [{ x: 20, y: 10, w: 10, h: 10, rgb: RED }] });
const OVER_CHANGE: IgnoreRect = { x: 18, y: 8, width: 14, height: 14 };

const VARIANT = { platform: "linux", browser: "chromium", viewport: "1280x720", theme: "light" };
const wholeTest = { name: "pricing", variant: null };
const variant = { name: "pricing", variant: VARIANT };

const deps = (ctx: Ctx) => ({ db: ctx.db, blobs: ctx.scoped });

/** Main with a white shot, then a branch build whose shot has a 10x10 change. */
async function changedBranch(ctx: Ctx, ignore: IgnoreRect[] = []) {
  await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white, ignore }] });
  return upload(ctx, {
    branch: "feat/x",
    commit: sha(2),
    mergeBase: sha(1),
    shots: [{ png: changed, ignore }],
  });
}

async function eve(ctx: Ctx) {
  const user = await signInGithubUser(ctx.db, {
    githubId: 2,
    login: "eve",
    name: null,
    avatarUrl: null,
  });
  await createOrg(ctx.db, user.id, "Elsewhere");
  return user;
}

describe("review-UI ignore boxes (ob 1499)", () => {
  test("a box over the change re-diffs the open build: unchanged, and the build passes", async () => {
    const ctx = await context();
    const build = await changedBranch(ctx);
    expect(build.status).toBe("changes");

    const saved = await addBoxAndRediff(deps(ctx), {
      userId: ctx.userId,
      build,
      target: wholeTest,
      rect: OVER_CHANGE,
    });
    expect(saved).toMatchObject({ changed: true, rediffed: 1, status: "passed", note: null });
    expect((await getBuild(ctx.db, ctx.projectId, build.id)).status).toBe("passed");
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("unchanged");
    expect(row.diffResult?.ignored).toEqual([OVER_CHANGE]);
    expect(row.resolvedDiff?.ignore).toEqual([
      expect.objectContaining({ ...OVER_CHANGE, scope: "test", by: "ada" }),
    ]);
    // The uploaded areas stay the shot's own: the box is the review UI's, stated apart.
    expect(row.ignore).toEqual([]);
  });

  test("a box is unioned with the uploaded areas, and the diff skips both", async () => {
    const ctx = await context();
    const uploaded: IgnoreRect = { x: 0, y: 0, width: 8, height: 8 };
    const build = await changedBranch(ctx, [uploaded]);
    await addBoxAndRediff(deps(ctx), {
      userId: ctx.userId,
      build,
      target: wholeTest,
      rect: OVER_CHANGE,
    });
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("unchanged");
    expect(row.diffResult?.ignored).toEqual([uploaded, OVER_CHANGE]);
    expect(row.diffResult?.ignoredPixels).toBe(8 * 8 + 14 * 14);
  });

  test("a variant's box applies to that variant only; a later build reads it", async () => {
    const ctx = await context();
    await changedBranch(ctx);
    await addIgnoreBox(ctx.db, ctx.userId, ctx.projectId, {
      ...variant,
      variant: { ...VARIANT, theme: "dark" },
      rect: OVER_CHANGE,
    });
    const later = async (n: number) =>
      upload(ctx, {
        branch: `feat/${n}`,
        commit: sha(n),
        mergeBase: sha(1),
        shots: [{ png: changed }],
      });
    // A dark-theme box leaves this light shot measured.
    expect((await onlyShot(ctx, await later(3))).diffStatus).toBe("changed");
    await addIgnoreBox(ctx.db, ctx.userId, ctx.projectId, { ...variant, rect: OVER_CHANGE });
    const row = await onlyShot(ctx, await later(4));
    expect(row.diffStatus).toBe("unchanged");
    expect(row.resolvedDiff?.ignore).toEqual([
      expect.objectContaining({ ...OVER_CHANGE, scope: "variant" }),
    ]);
  });

  test("clearing a box measures those pixels again, and keeps it in the trail", async () => {
    const ctx = await context();
    const build = await changedBranch(ctx);
    const set = { userId: ctx.userId, build, target: wholeTest, rect: OVER_CHANGE };
    await addBoxAndRediff(deps(ctx), set);
    const [box] = (await listIgnoreBoxes(ctx.db, ctx.userId, ctx.projectId)).active;
    if (!box) throw new Error("no box");

    const passed = await getBuild(ctx.db, ctx.projectId, build.id);
    const cleared = await clearBoxAndRediff(deps(ctx), {
      userId: ctx.userId,
      build: passed,
      boxId: box.id,
    });
    expect(cleared).toMatchObject({ changed: true, rediffed: 1, status: "changes" });
    const row = await onlyShot(ctx, build);
    expect(row.diffStatus).toBe("changed");
    expect(row.resolvedDiff?.ignore).toBeUndefined();

    const { active, trail } = await listIgnoreBoxes(ctx.db, ctx.userId, ctx.projectId);
    expect(active).toEqual([]);
    expect(trail).toEqual([
      expect.objectContaining({
        id: box.id,
        by: "ada",
        cleared: expect.objectContaining({ by: "ada" }),
      }),
    ]);
    // Clearing it again changes nothing.
    expect(
      await clearBoxAndRediff(deps(ctx), { userId: ctx.userId, build: passed, boxId: box.id }),
    ).toMatchObject({ changed: false, rediffed: 0 });
  });

  test("a member of another org cannot read, draw or clear a project's boxes", async () => {
    const ctx = await context();
    const id = await addIgnoreBox(ctx.db, ctx.userId, ctx.projectId, {
      ...wholeTest,
      rect: OVER_CHANGE,
    });
    const other = await eve(ctx);
    await expect(listIgnoreBoxes(ctx.db, other.id, ctx.projectId)).rejects.toThrow(NotFoundError);
    await expect(
      addIgnoreBox(ctx.db, other.id, ctx.projectId, { ...wholeTest, rect: OVER_CHANGE }),
    ).rejects.toThrow(NotFoundError);
    await expect(clearIgnoreBox(ctx.db, other.id, ctx.projectId, id)).rejects.toThrow(
      NotFoundError,
    );
    const { active } = await listIgnoreBoxes(ctx.db, ctx.userId, ctx.projectId);
    expect(active.map((b) => b.id)).toEqual([id]);
  });

  test("a CI project refuses a box: its diff is the CLI's", async () => {
    const ctx = await context();
    await ctx.db.update(projects).set({ diffLocation: "ci" }).where(eq(projects.id, ctx.projectId));
    await expect(
      addIgnoreBox(ctx.db, ctx.userId, ctx.projectId, { ...wholeTest, rect: OVER_CHANGE }),
    ).rejects.toThrow(OverrideError);
  });

  test("the export, uploaded as config ignore instead of the boxes, gives the same verdicts", async () => {
    const config = {
      baseUrl: "http://localhost:3000",
      routes: [
        { path: "/pricing", name: "pricing" },
        { path: "/home", name: "home" },
      ],
    };
    const names = ["pricing", "home"];
    const shots = (png: Uint8Array<ArrayBuffer>, ignoreOf: (name: string) => IgnoreRect[]) =>
      names.map((name) => ({ name, png, ignore: ignoreOf(name) }));

    // With boxes: pricing's test-wide one, home's variant one.
    const withUi = await context();
    await upload(withUi, { branch: "main", commit: sha(1), shots: shots(white, () => []) });
    await addIgnoreBox(withUi.db, withUi.userId, withUi.projectId, {
      ...wholeTest,
      rect: OVER_CHANGE,
    });
    await addIgnoreBox(withUi.db, withUi.userId, withUi.projectId, {
      name: "home",
      variant: VARIANT,
      rect: OVER_CHANGE,
    });
    const byUi = await upload(withUi, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: shots(changed, () => []),
    });

    // Without: the export merged into the config, each shot uploaded with its resolved ignore.
    const { active } = await listIgnoreBoxes(withUi.db, withUi.userId, withUi.projectId);
    const exported = exportOverrides([], active);
    const merged = parseConfig({
      baseUrl: config.baseUrl,
      variants: exported.variants,
      routes: config.routes.map((r) => {
        const e = exported.routes.find((x) => x.name === r.name);
        return { ...r, ignore: e?.ignore, variants: e?.variants };
      }),
    });
    const [as] = merged.variants;
    if (!as) throw new Error("no variant");
    const ignoreOf = (name: string): IgnoreRect[] => {
      const route = merged.routes.find((r) => r.name === name);
      if (!route) throw new Error(`no route ${name}`);
      return resolveIgnore(merged, route, as).filter(
        (a): a is IgnoreRect => typeof a === "object" && "width" in a,
      );
    };
    const withConfig = await context();
    await upload(withConfig, { branch: "main", commit: sha(1), shots: shots(white, ignoreOf) });
    const byConfig = await upload(withConfig, {
      branch: "feat/x",
      commit: sha(2),
      mergeBase: sha(1),
      shots: shots(changed, ignoreOf),
    });

    const verdicts = async (ctx: Ctx, build: typeof byUi) =>
      (await rows(ctx, build))
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((r) => [r.name, r.diffStatus, r.diffResult?.ignored]);
    expect(byUi.status).toBe("passed");
    expect(byConfig.status).toBe(byUi.status);
    expect(await verdicts(withConfig, byConfig)).toEqual(await verdicts(withUi, byUi));
  });

  test("an uploaded area's source is the manifest for a PNG import, otherwise the config", async () => {
    const ctx = await context();
    const captured = await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: white }] });
    const imported = await upload(ctx, {
      branch: "feat/png",
      commit: sha(2),
      mergeBase: sha(1),
      shots: [{ png: white, fingerprint: { image: "external", browser: "", fonts: "" } }],
    });
    expect(await uploadedIgnoreSource(ctx.db, (await onlyShot(ctx, captured)).id)).toBe("config");
    expect(await uploadedIgnoreSource(ctx.db, (await onlyShot(ctx, imported)).id)).toBe("manifest");
  });
});
