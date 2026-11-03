import { beforeEach, describe, expect, test } from "vitest";
import { twinLabel, twinSourceLabel, unlinkedLine } from "#/lib/twins";
import { NotFoundError } from "./db";
import { twinsOfBuild } from "./twins";
import { type World, PIXEL, world } from "./twins-test-support";

/** The pairing function (PS-295) on a real schema: one project, in its own build and against its baselines. */

let db: World["db"];
let web: World["web"];
let build: World["build"];
let idOf: World["idOf"];

beforeEach(async () => {
  ({ db, web, build, idOf } = await world());
});

describe("twinsOfBuild: one project", () => {
  test("pairs a web and an android shot of the same build by name and theme", async () => {
    const b = await build(web, 1, [
      { platform: "linux", metrics: true },
      { platform: "android" },
      { platform: "android", name: "Button/loading" },
    ]);
    const twins = await twinsOfBuild(db, b);
    expect(twins.twinProject).toBeNull();
    expect(twins.linked.map((e) => [e.platform, e.name])).toEqual([
      ["android", "Button/primary"],
      ["web", "Button/primary"],
    ]);
    const webEntry = twins.linked.find((e) => e.platform === "web");
    expect(webEntry).toMatchObject({ device: null, hasMetrics: true, missing: [] });
    expect(webEntry?.twins).toEqual([
      expect.objectContaining({
        snapshotId: await idOf(b, "Button/primary", "android"),
        platform: "android",
        device: PIXEL,
        projectId: web,
        buildId: b,
        source: { kind: "build", commitSha: null },
        hasMetrics: false,
      }),
    ]);
    expect(
      twinSourceLabel(webEntry?.twins[0]?.source ?? { kind: "baselines", commitSha: null }),
    ).toBe("same build");
    expect(twinLabel(webEntry?.twins[0] ?? { platform: "web", device: null })).toBe(
      `android · ${PIXEL}`,
    );
    // The android-only shot has no web twin.
    expect(twins.unlinked.map((e) => unlinkedLine(e))).toEqual([
      "Button/loading dark has no web twin",
    ]);
  });

  test("the theme is part of the key: a light web shot is not the twin of a dark android one", async () => {
    const b = await build(web, 1, [
      { platform: "linux", theme: "light" },
      { platform: "android", theme: "dark" },
    ]);
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked).toEqual([]);
    expect(twins.unlinked.map(unlinkedLine)).toEqual([
      "Button/primary dark has no web twin",
      "Button/primary light has no android twin",
    ]);
  });

  test("lists every viewport and device a side holds for the key", async () => {
    const b = await build(web, 1, [
      { platform: "linux", viewport: "1280x720" },
      { platform: "linux", viewport: "390x844", browser: "webkit" },
      { platform: "android", browser: PIXEL },
      { platform: "android", browser: "Pixel Tablet API 35", viewport: "1280x800" },
      { platform: "ios", browser: "iPhone 16", viewport: "393x852" },
    ]);
    const twins = await twinsOfBuild(db, b);
    expect(twins.unlinked).toEqual([]);
    const first = twins.linked.find((e) => e.platform === "web" && e.viewport === "1280x720");
    expect(first?.twins.map((t) => [t.platform, t.device, t.viewport])).toEqual([
      ["android", PIXEL, "412x915"],
      ["android", "Pixel Tablet API 35", "1280x800"],
      ["ios", "iPhone 16", "393x852"],
    ]);
    const ios = twins.linked.find((e) => e.platform === "ios");
    expect(ios?.twins.map((t) => [t.platform, t.viewport])).toEqual([
      ["android", "412x915"],
      ["android", "1280x800"],
      ["web", "1280x720"],
      ["web", "390x844"],
    ]);
    expect(twins.linked).toHaveLength(5);
  });

  test("a shot with a twin on one platform but not on the third names the platform it lacks", async () => {
    const b = await build(web, 1, [
      { platform: "linux" },
      { platform: "android" },
      { platform: "ios", name: "Other" },
    ]);
    const twins = await twinsOfBuild(db, b);
    const primaryWeb = twins.unlinked.find((e) => e.platform === "web");
    expect(primaryWeb?.missing).toEqual(["ios"]);
    expect(primaryWeb?.twins.map((t) => t.platform)).toEqual(["android"]);
    expect(unlinkedLine(primaryWeb ?? { name: "", theme: "", missing: [] })).toBe(
      "Button/primary dark has no ios twin",
    );
    const other = twins.unlinked.find((e) => e.name === "Other");
    expect(unlinkedLine(other ?? { name: "", theme: "", missing: [] })).toBe(
      "Other dark has no web or android twin",
    );
  });

  test("a build with no native shot returns nothing, and no error", async () => {
    const b = await build(web, 1, [{ platform: "linux" }, { name: "Card", platform: "linux" }]);
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });

  test("a build with no shots at all returns nothing", async () => {
    const b = await build(web, 1, []);
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });

  test("an unknown build is a NotFoundError", async () => {
    await expect(twinsOfBuild(db, "nope")).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a removed marker is not a shot of its build", async () => {
    const b = await build(web, 1, [
      { platform: "linux" },
      { platform: "android", diff: "removed" },
    ]);
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });
});

describe("twinsOfBuild: the current baselines", () => {
  test("a web-only build falls back to the project's accepted android baseline", async () => {
    const old = await build(web, 1, [{ platform: "android", metrics: true }], { age: 30 });
    const b = await build(web, 2, [{ platform: "linux" }], { status: "changes", age: 0 });
    const twins = await twinsOfBuild(db, b);
    expect(twins.unlinked).toEqual([]);
    expect(twins.linked).toHaveLength(1);
    expect(twins.linked[0]?.twins).toEqual([
      expect.objectContaining({
        snapshotId: await idOf(old, "Button/primary", "android"),
        buildId: old,
        hasMetrics: true,
        source: { kind: "baselines", commitSha: null },
      }),
    ]);
    expect(
      twinSourceLabel(twins.linked[0]?.twins[0]?.source ?? { kind: "build", commitSha: null }),
    ).toBe("baselines");
  });

  test("takes the newest accepted shot per key, not an older one", async () => {
    await build(web, 1, [{ platform: "android" }], { age: 60 });
    const newer = await build(web, 2, [{ platform: "android" }], { age: 30 });
    const b = await build(web, 3, [{ platform: "linux" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked[0]?.twins.map((t) => t.buildId)).toEqual([newer]);
  });

  test("only accepted shots are baselines: a pending shot of a changed build is not", async () => {
    await build(web, 1, [{ platform: "android", diff: "changed" }], { status: "changes", age: 30 });
    const b = await build(web, 2, [{ platform: "linux" }], { status: "changes" });
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
    // Accepted by a reviewer, the same shot is the baseline.
    const accepted = await build(
      web,
      3,
      [{ platform: "android", diff: "changed", state: "accepted" }],
      { status: "changes", age: 20 },
    );
    const twins = await twinsOfBuild(db, b);
    expect(twins.linked[0]?.twins.map((t) => t.buildId)).toEqual([accepted]);
  });

  test("an uploading build, an errored build and a removed marker are not baselines", async () => {
    await build(web, 1, [{ platform: "android" }], { status: "uploading", age: 30 });
    await build(web, 2, [{ platform: "android" }], { status: "errored", age: 20 });
    await build(web, 3, [{ platform: "android", diff: "removed" }], { age: 10 });
    const b = await build(web, 4, [{ platform: "linux" }], { status: "changes" });
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });

  test("the build itself is never its own baseline", async () => {
    const b = await build(web, 1, [{ platform: "linux" }], { status: "passed" });
    expect(await twinsOfBuild(db, b)).toEqual({ twinProject: null, linked: [], unlinked: [] });
  });

  test("a baseline of a key the build lacks leaves the shot unlinked on that platform", async () => {
    await build(web, 1, [{ platform: "android", name: "Other" }], { age: 30 });
    const b = await build(web, 2, [{ platform: "linux" }], { status: "changes" });
    const twins = await twinsOfBuild(db, b);
    expect(twins.unlinked.map(unlinkedLine)).toEqual(["Button/primary dark has no android twin"]);
  });
});
