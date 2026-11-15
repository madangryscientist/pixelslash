import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setGithubRepo } from "#/db/orgs";
import { decideAll } from "#/db/review";
import { builds } from "#/db/schema";
import { sha } from "#/diff/test-builds";
import { reportError } from "#/server/sentry";
import type { StatusBody } from "./check-run";
import { type Call, TEST_TOKEN } from "./test-github";
import { CHANGED, PLAIN, world } from "./test-world";

vi.mock("#/server/sentry", () => ({ reportError: vi.fn<typeof reportError>() }));

/** The commit status the App posts on a build's commit (PS-23), against a stand-in for GitHub's API. */

const bodies = (calls: Call[]) => calls.map((c): StatusBody => JSON.parse(c.raw));
const states = (calls: Call[]) => bodies(calls).map((b) => `${b.state} ${b.description}`);

afterEach(() => {
  vi.mocked(reportError).mockClear();
  vi.restoreAllMocks();
});

describe("the PixelSlash commit status from the App", () => {
  test("a build with nothing changed goes pending, then success, on its own commit; no check run", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });

    expect(main.body.status).toBe("passed");
    const posts = w.github.statusCalls();
    expect(posts.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /repos/acme/web/statuses/${sha(1)}`,
      `POST /repos/acme/web/statuses/${sha(1)}`,
    ]);
    expect(states(posts)).toEqual(["pending Diffing the shots", "success No visual changes"]);
    const page = `https://pixelslash.test/projects/${w.acme.project.id}/builds/${main.id}`;
    expect(bodies(posts)[1]).toEqual({
      state: "success",
      context: "PixelSlash",
      description: "No visual changes",
      target_url: page,
    });
    // Sent with the App's installation token, not created as a check run.
    expect(posts.every((c) => c.auth.startsWith("Bearer ghs_"))).toBe(true);
    expect(w.github.checkRunCalls()).toEqual([]);
    expect((await w.buildRow(main.id))?.checkRunId).toBeNull();
  });

  test("a change keeps it pending until it is accepted, and a reject fails it", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const before = w.github.statusCalls().length;
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    expect(feature.body.status).toBe("changes");

    await w.sync(await w.decide(feature.id, "accepted"));
    await w.sync(await w.decide(feature.id, "rejected"));

    const posts = w.github.statusCalls().slice(before);
    expect(posts.every((c) => c.path === `/repos/acme/web/statuses/${sha(2)}`)).toBe(true);
    expect(states(posts)).toEqual([
      "pending Diffing the shots",
      "pending 1 change to review",
      "success All changes accepted",
      "failure 1 change rejected",
    ]);
    expect(w.github.checkRunCalls()).toEqual([]);
  });

  test("rejecting a waiting change moves it from pending to failure", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const before = w.github.statusCalls().length;
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    await w.sync(await w.decide(feature.id, "rejected"));
    expect(states(w.github.statusCalls().slice(before))).toEqual([
      "pending Diffing the shots",
      "pending 1 change to review",
      "failure 1 change rejected",
    ]);
  });

  test("accept-all moves it to success", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    const decided = await decideAll(w.db, {
      projectId: w.acme.project.id,
      buildId: feature.id,
      userId: w.acme.user.id,
    });
    await w.sync(decided.buildIds);
    expect(states(w.github.statusCalls()).at(-1)).toBe("success All changes accepted");
  });

  test("an errored build fails it, and the description names the error", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.db
      .update(builds)
      .set({ status: "errored", error: "the diff ran out of time" })
      .where(eq(builds.id, main.id));
    await w.sync([main.id]);
    expect(bodies(w.github.statusCalls()).at(-1)).toMatchObject({
      state: "failure",
      description: "Build errored: the diff ran out of time",
    });
  });

  test("the App posts the status; the token is not used when both are configured", async () => {
    const w = await world({ token: true });
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    expect(main.body.status).toBe("passed");
    expect(w.github.statusCalls().length).toBe(2);
    expect(w.github.checkRunCalls()).toEqual([]);
    expect(w.github.calls.some((c) => c.auth === `Bearer ${TEST_TOKEN}`)).toBe(false);
  });

  test("a project with no repo, or a server with no App, calls GitHub not at all", async () => {
    for (const setting of [{ repo: null }, { app: false }]) {
      const w = await world(setting);
      const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
      expect(main.body.status).toBe("passed");
      expect(w.github.calls).toEqual([]);
    }
  });

  test("a project moved to another repo posts its status there", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await setGithubRepo(w.db, w.acme.user.id, w.acme.project.id, "acme/site");
    await w.sync([main.id]);
    const last = w.github.statusCalls().at(-1);
    expect(`${last?.method} ${last?.path}`).toBe(`POST /repos/acme/site/statuses/${sha(1)}`);
  });

  test("a build holding a check run from before completes it once as neutral, then forgets it", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.db.update(builds).set({ checkRunId: 55 }).where(eq(builds.id, main.id));
    const before = w.github.statusCalls().length;

    await w.sync([main.id]);
    const runs = w.github.checkRunCalls();
    expect(runs.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /repos/acme/web/check-runs/55",
    ]);
    expect(JSON.parse(runs[0]?.raw ?? "{}")).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Moved to the PixelSlash commit status" },
    });
    expect((await w.buildRow(main.id))?.checkRunId).toBeNull();
    expect(states(w.github.statusCalls().slice(before))).toEqual(["success No visual changes"]);

    // The next sync sends the status alone.
    await w.sync([main.id]);
    expect(w.github.checkRunCalls().length).toBe(1);
    expect(w.github.statusCalls().length).toBe(before + 2);
  });

  test("a token-only server leaves an old check run alone: it cannot complete it", async () => {
    const w = await world({ app: false, token: true });
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.db.update(builds).set({ checkRunId: 55 }).where(eq(builds.id, main.id));
    await w.sync([main.id]);
    expect(w.github.checkRunCalls()).toEqual([]);
    expect((await w.buildRow(main.id))?.checkRunId).toBe(55);
  });

  test("a 403 on the status is logged, not reported, and the PR comment still syncs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = await world();
    w.github.failStatuses(403);
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.finalise({ commit: sha(2), branch: "feat/x", mergeBase: sha(1), png: CHANGED, pr: 7 });

    expect(w.github.statusCalls().length).toBeGreaterThan(0);
    expect(w.github.commentCalls().map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/issues/7/comments",
    ]);
    expect(warn.mock.calls.some(([line]) => String(line).includes("commit status"))).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  test("any other failure on the status is reported", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = await world();
    w.github.failStatuses(422);
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    expect(reportError).toHaveBeenCalled();
  });

  test.each([
    ["a 5xx", { status: 502 } as const],
    ["a timeout", "hang" as const],
  ])("%s from GitHub leaves the finalise reply and the verdict as they were", async (_, mode) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    w.github.setMode(mode);
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });

    expect(feature.status).toBe(200);
    expect(feature.body).toMatchObject({ status: "changes", error: null });
    await w.sync(await w.decide(feature.id, "accepted"));
    expect((await w.buildRow(feature.id))?.status).toBe("passed");

    // GitHub back: the next sync posts the state the build has now.
    w.github.setMode("ok");
    await w.sync([feature.id]);
    expect(states(w.github.statusCalls().slice(-1))).toEqual(["success All changes accepted"]);
  });

  test("two projects on one repo each name their status after the project; the repo ignores case", async () => {
    const w = await world({ repo: "acme/web" });
    const docs = await w.linkProject("docs", "Acme/Web");
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN, token: docs });

    const posts = w.github.statusCalls();
    expect(bodies(posts).map((b) => b.context)).toEqual([
      "PixelSlash / web",
      "PixelSlash / web",
      "PixelSlash / docs",
      "PixelSlash / docs",
    ]);
    // Each project's repo spelling is kept in its path.
    expect(posts.map((c) => c.path)).toEqual([
      `/repos/acme/web/statuses/${sha(1)}`,
      `/repos/acme/web/statuses/${sha(1)}`,
      `/repos/Acme/Web/statuses/${sha(1)}`,
      `/repos/Acme/Web/statuses/${sha(1)}`,
    ]);
  });

  test("a project on another repo, or another org's on the same repo, leaves the plain name", async () => {
    const w = await world({ repo: "acme/web" });
    await w.linkProject("docs", "acme/docs");
    await setGithubRepo(w.db, w.other.user.id, w.other.project.id, "acme/web");
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });

    expect(bodies(w.github.statusCalls()).map((b) => b.context)).toEqual([
      "PixelSlash",
      "PixelSlash",
    ]);
  });
});
