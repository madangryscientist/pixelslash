import { beforeEach, describe, expect, test } from "vitest";
import { twinSourceLabel, unlinkedLine } from "#/lib/twins";
import { NotFoundError } from "./db";
import { createOrg, createProject } from "./orgs";
import { projects } from "./schema";
import { TwinProjectError, setTwinProject, twinsOfBuild } from "./twins";
import { signInGithubUser } from "./users";
import { type World, shaOf as sha, world } from "./twins-test-support";

/** The pairing function (PS-295) on a real schema: a linked twin project, and the link setting. */

let db: World["db"];
let userId: World["userId"];
let web: World["web"];
let native: World["native"];
let build: World["build"];

beforeEach(async () => {
  ({ db, userId, web, native, build } = await world());
});

describe("twinsOfBuild: a linked twin project", () => {
  beforeEach(async () => {
    await setTwinProject(db, userId, web, native);
  });

  test("takes the twin project's newest build with the same commit", async () => {
    await build(native, 7, [{ platform: "android" }], { age: 60 });
    const older = await build(native, 9, [{ platform: "android" }], { age: 40 });
    const newest = await build(native, 9, [{ platform: "android", metrics: true }], { age: 20 });
    await build(native, 9, [{ platform: "android" }], { status: "uploading", age: 0 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(older).not.toBe(newest);
    expect(twins.twinProject).toEqual({ id: native, name: "native" });
    expect(twins.linked).toHaveLength(1);
    expect(twins.linked[0]?.twins).toEqual([
      expect.objectContaining({
        buildId: newest,
        projectId: native,
        projectName: "native",
        hasMetrics: true,
        source: { kind: "commit", commitSha: sha(9) },
      }),
    ]);
    expect(
      twinSourceLabel(twins.linked[0]?.twins[0]?.source ?? { kind: "build", commitSha: null }),
    ).toBe(`same commit ${sha(9).slice(0, 7)}`);
  });

  test("with no build at the commit, falls back to the twin project's baselines", async () => {
    const base = await build(native, 3, [{ platform: "android" }], { age: 30 });
    await build(native, 4, [{ platform: "android" }], { status: "changes", age: 20 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked[0]?.twins).toEqual([
      expect.objectContaining({
        buildId: base,
        projectId: native,
        source: { kind: "baselines", commitSha: null },
      }),
    ]);
  });

  test("a build at the commit is authoritative: a key it lacks is unlinked, not read from baselines", async () => {
    await build(native, 3, [{ platform: "android" }], { age: 30 });
    await build(native, 9, [{ platform: "android", name: "Other" }], { age: 20 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked).toEqual([]);
    expect(twins.unlinked.map(unlinkedLine)).toEqual(["Button/primary dark has no android twin"]);
  });

  test("works from the native side too: the native build finds the web twin by commit", async () => {
    await setTwinProject(db, userId, native, web);
    const w = await build(web, 5, [{ platform: "linux" }], { age: 10 });
    const b = await build(native, 5, [{ platform: "android" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked[0]?.twins.map((t) => [t.buildId, t.platform])).toEqual([[w, "web"]]);
  });

  test("a project's own CI token reads without the link", async () => {
    await build(native, 9, [{ platform: "android" }], { age: 20 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    expect(await twinsOfBuild(db, b, { crossProject: false })).toEqual({
      twinProject: null,
      linked: [],
      unlinked: [],
    });
  });

  test("a link to another org's project is never honoured, whatever the row says", async () => {
    const stranger = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    const elsewhere = await createOrg(db, stranger.id, "Elsewhere");
    const foreign = await createProject(db, stranger.id, elsewhere.id, "native");
    await db.update(projects).set({ twinProjectId: foreign.id });
    await build(foreign.id, 9, [{ platform: "android" }], { age: 20 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });
});

describe("a web-only project is unchanged", () => {
  test("a twin project with no native shot adds nothing", async () => {
    await setTwinProject(db, userId, web, native);
    await build(native, 9, [{ platform: "linux" }], { age: 20 });
    const b = await build(web, 9, [{ platform: "linux" }], { status: "changes" });
    expect(await twinsOfBuild(db, b)).toEqual({
      twinProject: { id: native, name: "native" },
      linked: [],
      unlinked: [],
    });
  });
});

describe("setTwinProject", () => {
  test("names a project of the org, and null clears it", async () => {
    await setTwinProject(db, userId, web, native);
    const twinOf = async () =>
      (await db.select().from(projects)).find((p) => p.id === web)?.twinProjectId;
    expect(await twinOf()).toBe(native);
    await setTwinProject(db, userId, web, null);
    expect(await twinOf()).toBeNull();
  });

  test("refuses a project of another org, an unknown one and the project itself", async () => {
    const stranger = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    const elsewhere = await createOrg(db, stranger.id, "Elsewhere");
    const foreign = await createProject(db, stranger.id, elsewhere.id, "native");
    await expect(setTwinProject(db, userId, web, foreign.id)).rejects.toBeInstanceOf(
      TwinProjectError,
    );
    await expect(setTwinProject(db, userId, web, "nope")).rejects.toBeInstanceOf(TwinProjectError);
    await expect(setTwinProject(db, userId, web, web)).rejects.toBeInstanceOf(TwinProjectError);
    expect((await db.select().from(projects)).find((p) => p.id === web)?.twinProjectId).toBeNull();
  });

  test("a non-member gets the same not-found as every other setting", async () => {
    const stranger = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });
    await expect(setTwinProject(db, stranger.id, web, native)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
