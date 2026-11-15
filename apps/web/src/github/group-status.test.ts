import { describe, expect, test } from "vitest";
import { sha } from "#/diff/test-builds";
import { call, newBuild } from "#/api/test-support";
import type { StatusBody } from "./check-run";
import type { Call } from "./test-github";
import { CHANGED, PLAIN, world } from "./test-world";

/**
 * One PixelSlash status for a project and its subprojects on a commit (the App posts statuses,
 * PS-570): every build of the group syncs the same context, from each project's newest build there.
 */

const bodies = (calls: Call[]) => calls.map((c): StatusBody => JSON.parse(c.raw));
const last = (w: Awaited<ReturnType<typeof world>>) => bodies(w.github.statusCalls()).at(-1);

/** P (acme's `web` on acme/web) with subprojects `a` and `b`, and main's first builds of each. */
async function group() {
  const w = await world();
  const a = await w.addSubproject("a");
  const b = await w.addSubproject("b");
  for (const subproject of [undefined, "a", "b"])
    await w.finalise({
      commit: sha(1),
      branch: "main",
      png: PLAIN,
      ...(subproject ? { subproject } : {}),
    });
  const before = w.github.statusCalls().length;
  const on = (subproject?: string, png = PLAIN) =>
    w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png,
      ...(subproject ? { subproject } : {}),
    });
  return { ...w, a, b, on, since: () => bodies(w.github.statusCalls().slice(before)) };
}

describe("a project's status with subprojects", () => {
  test("P, a and b on one commit post one context, named after P, never after a subproject", async () => {
    const w = await group();
    await w.on();
    await w.on("a");
    await w.on("b");
    const posts = w.github.statusCalls().slice(-6);
    expect(new Set(posts.map((c) => c.path))).toEqual(
      new Set([`/repos/acme/web/statuses/${sha(2)}`]),
    );
    expect(new Set(w.since().map((s) => s.context))).toEqual(new Set(["PixelSlash"]));
    expect(last(w)).toEqual({
      state: "success",
      context: "PixelSlash",
      description: "No visual changes",
      target_url: `https://pixelslash.test/projects/${w.acme.project.id}`,
    });
    // A subproject's build posts no PR comment of its own, and no check run.
    expect(w.github.checkRunCalls()).toEqual([]);
  });

  test("failure when any counted build fails, even while another is processing", async () => {
    const w = await group();
    await w.on();
    const failing = await w.on("a", CHANGED);
    await w.sync(await w.decide(failing.id, "rejected", w.a.id));
    expect(last(w)).toMatchObject({ state: "failure", description: "a: 1 change rejected" });
    // b opens a build on the commit and is still uploading: the failure is not hidden by it.
    const opened = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ commitSha: sha(2), branch: "feat/x", subproject: "b" }),
    );
    expect(opened.status).toBe(201);
    await w.sync([failing.id]);
    expect(last(w)?.state).toBe("failure");
  });

  test("pending while a change waits, with the total, and accepting the last one in b turns it green", async () => {
    const w = await group();
    await w.on();
    await w.on("a");
    const waiting = await w.on("b", CHANGED);
    expect(waiting.body.status).toBe("changes");
    expect(last(w)).toMatchObject({
      state: "pending",
      description: "1 change to review in 1 subproject",
    });
    await w.sync(await w.decide(waiting.id, "accepted", w.b.id));
    expect(last(w)).toMatchObject({ state: "success", description: "All changes accepted" });
  });

  test("a commit where only a uploads: its status comes from a alone, and links to that build", async () => {
    const w = await group();
    const only = await w.on("a");
    expect(last(w)).toEqual({
      state: "success",
      context: "PixelSlash",
      description: "No visual changes",
      target_url: `https://pixelslash.test/projects/${w.a.id}/builds/${only.id}`,
    });
  });

  test("a commit where only `upload --skipped` runs gets a success status", async () => {
    const w = await group();
    const res = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ commitSha: sha(2), branch: "feat/x", skipped: true }),
    );
    expect(res.status).toBe(201);
    expect(last(w)).toMatchObject({ state: "success", context: "PixelSlash" });
  });

  test("a rerun that skips keeps the commit's failure: the build a already has stands", async () => {
    const w = await group();
    const failing = await w.on("a", CHANGED);
    await w.sync(await w.decide(failing.id, "rejected", w.a.id));
    const rerun = await call(
      w.deps,
      "POST /api/v1/builds",
      w.acme.token,
      newBuild({ commitSha: sha(2), branch: "feat/x", subproject: "a", skipped: true }),
    );
    expect(rerun.status).toBe(200);
    expect(await rerun.json()).toMatchObject({ id: failing.id, status: "failed", skipped: false });
    await w.sync([failing.id]);
    expect(last(w)?.state).toBe("failure");
  });

  test("a skipped rerun after an upload that died counts: the open build does not hold the status", async () => {
    const w = await group();
    const post = (extra: Record<string, unknown>) =>
      call(
        w.deps,
        "POST /api/v1/builds",
        w.acme.token,
        newBuild({ commitSha: sha(2), branch: "feat/x", subproject: "a", ...extra }),
      );
    expect((await post({})).status).toBe(201);
    expect((await post({ skipped: true })).status).toBe(201);
    expect(w.github.statusCalls().at(-1)?.path).toBe(`/repos/acme/web/statuses/${sha(2)}`);
    expect(last(w)).toMatchObject({ state: "success", context: "PixelSlash" });
  });

  test("a project with no subprojects keeps its one-build status, as before", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    expect(last(w)?.target_url).toBe(
      `https://pixelslash.test/projects/${w.acme.project.id}/builds/${main.id}`,
    );
  });
});
