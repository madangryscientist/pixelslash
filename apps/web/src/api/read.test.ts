import { describe, expect, test } from "vitest";
import { flagSnapshot } from "#/db/flags";
import { reviewSnapshot } from "#/db/review";
import { sha } from "#/diff/test-builds";
import { verifySignedImagePath } from "#/storage/signed";
import { get, world } from "./test-read";

describe("the read API (ob 1729)", () => {
  test("projects: a personal token sees its user's orgs, a CI token its one project", async () => {
    const w = await world();
    const mine = await get(w.deps, "/api/v1/projects", w.ada);
    expect(mine.status).toBe(200);
    expect(mine.body.api_version).toBe(1);
    expect(mine.body.projects.map((p: { org: { name: string } }) => p.org.name)).toEqual([
      "Acme",
      "Other",
    ]);
    expect(mine.body.projects[0]).toMatchObject({
      id: w.projectId,
      name: "web",
      org: { id: w.orgId, name: "Acme" },
      default_branch: "main",
      web_url: `http://app.test/projects/${w.projectId}`,
    });
    const ci = await get(w.deps, "/api/v1/projects", w.acme.token);
    expect(mine.body.next_cursor).toBeNull();
    expect(ci.body.projects.map((p: { id: string }) => p.id)).toEqual([w.projectId]);
    expect((await get(w.deps, "/api/v1/projects", w.eve)).body.projects).toEqual([]);
  });

  test("builds: newest first with counts, filtered by branch and status", async () => {
    const w = await world();
    const all = await get(w.deps, `/api/v1/projects/${w.projectId}/builds`, w.acme.token);
    expect(all.status).toBe(200);
    expect(all.body.next_cursor).toBeNull();
    expect(all.body.builds.map((b: { branch: string }) => b.branch)).toEqual(["feature", "main"]);
    expect(all.body.builds[0]).toEqual({
      id: w.feature.id,
      project_id: w.projectId,
      branch: "feature",
      commit_sha: sha(2),
      pr_number: null,
      status: "changes",
      error: null,
      counts: {
        changed: 1,
        new: 1,
        removed: 1,
        unchanged: 1,
        rebaseline: 0,
        unmeasured: 0,
        pending: 4,
        accepted: 0,
        rejected: 0,
        to_review: 1,
      },
      created_at: expect.any(String),
      web_url: `http://app.test/projects/${w.projectId}/builds/${w.feature.id}`,
    });
    const onMain = await get(w.deps, `/api/v1/projects/${w.projectId}/builds?branch=main`, w.ada);
    expect(onMain.body.builds.map((b: { id: string }) => b.id)).toEqual([w.main.id]);
    expect(onMain.body.builds[0]?.counts).toMatchObject({ new: 3, accepted: 3, pending: 0 });
    const passed = await get(w.deps, `/api/v1/projects/${w.projectId}/builds?status=passed`, w.ada);
    expect(passed.body.builds.map((b: { id: string }) => b.id)).toEqual([w.main.id]);
    const bad = await get(w.deps, `/api/v1/projects/${w.projectId}/builds?status=green`, w.ada);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_request");
  });

  test("builds: a cursor walks the list a page at a time and a forged one is a 400", async () => {
    const w = await world();
    const path = `/api/v1/projects/${w.projectId}/builds`;
    const first = await get(w.deps, `${path}?limit=1`, w.ada);
    expect(first.body.builds.map((b: { id: string }) => b.id)).toEqual([w.feature.id]);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await get(w.deps, `${path}?limit=1&cursor=${first.body.next_cursor}`, w.ada);
    expect(second.body.builds.map((b: { id: string }) => b.id)).toEqual([w.main.id]);
    expect(second.body.next_cursor).toBeNull();
    expect((await get(w.deps, `${path}?cursor=%%%`, w.ada)).status).toBe(400);
    expect((await get(w.deps, `${path}?cursor=bm9wZQ`, w.ada)).status).toBe(400);
    const huge = btoa(`${"9".repeat(400)}:x`);
    expect((await get(w.deps, `${path}?cursor=${huge}`, w.ada)).status).toBe(400);
    expect((await get(w.deps, `${path}?limit=0`, w.ada)).status).toBe(400);
    expect((await get(w.deps, `${path}?limit=101`, w.ada)).status).toBe(400);
  });

  test("builds: another org's project is a 404 for a CI token and for an outsider", async () => {
    const w = await world();
    const other = `/api/v1/projects/${w.other.project.id}/builds`;
    const ci = await get(w.deps, other, w.acme.token);
    expect(ci).toEqual({
      status: 404,
      body: { api_version: 1, error: { code: "not_found", message: "project not found" } },
    });
    expect((await get(w.deps, `/api/v1/projects/${w.projectId}/builds`, w.eve)).status).toBe(404);
    expect((await get(w.deps, other, w.ada)).status).toBe(200);
  });

  test("a build carries its shots in review order, with what the diff measured", async () => {
    const w = await world();
    const about = await w.shotOf(w.feature.id, "about");
    await reviewSnapshot(w.db, {
      projectId: w.projectId,
      snapshotId: about.id,
      state: "accepted",
      userId: w.userId,
    });
    const res = await get(w.deps, `/api/v1/builds/${w.feature.id}`, w.acme.token);
    expect(res.status).toBe(200);
    const { build } = res.body;
    expect(build).toMatchObject({ id: w.feature.id, status: "passed", branch: "feature" });
    expect(build.counts).toMatchObject({ accepted: 1, pending: 3, to_review: 0 });
    expect(
      build.snapshots.map((s: { name: string; group: string }) => `${s.name}:${s.group}`),
    ).toEqual(["about:changed", "pricing:new", "contact:removed", "home:unchanged"]);
    const [changed] = build.snapshots;
    expect(changed).toMatchObject({
      id: about.id,
      build_id: w.feature.id,
      diff_status: "changed",
      review_state: "accepted",
      reviewed_by: "ada",
      reviewed_at: expect.any(String),
      awaits_decision: false,
      carried_from: null,
      approved_earlier: null,
      web_url: `http://app.test/projects/${w.projectId}/builds/${w.feature.id}/snapshots/${about.id}`,
    });
    expect(changed?.diff_result).toMatchObject({ size_changed: false, width: expect.any(Number) });
    expect(changed?.diff_result?.changed_pixels).toBeGreaterThan(0);
    expect(changed?.diff_result?.regions[0]).toMatchObject({
      kind: "change",
      changed_pixels: expect.any(Number),
    });
    expect(changed).not.toHaveProperty("images");
  });

  test("a build of another project is a 404 for a CI token", async () => {
    const w = await world();
    expect((await get(w.deps, `/api/v1/builds/${w.otherBuild.id}`, w.acme.token)).status).toBe(404);
    expect((await get(w.deps, `/api/v1/builds/${w.feature.id}`, w.eve)).status).toBe(404);
    expect((await get(w.deps, `/api/v1/builds/nope`, w.ada)).status).toBe(404);
  });

  test("a snapshot links its three images through the signed image route", async () => {
    const w = await world();
    const about = await w.shotOf(w.feature.id, "about");
    const res = await get(w.deps, `/api/v1/snapshots/${about.id}`, w.ada);
    expect(res.status).toBe(200);
    const { snapshot } = res.body;
    expect(snapshot).toMatchObject({ id: about.id, name: "about", diff_status: "changed" });
    for (const [which, key] of [
      ["head", about.imageKey],
      ["baseline", about.baselineKey],
      ["diff", about.diffKey],
    ] as const) {
      const url = new URL(snapshot.images[which] ?? "");
      expect(url.origin).toBe("http://app.test");
      expect(decodeURIComponent(url.pathname)).toBe(`/images/${key}`);
      const ok = await verifySignedImagePath({
        key: key ?? "",
        expires: url.searchParams.get("exp"),
        sig: url.searchParams.get("sig"),
        secret: "test-image-secret",
      });
      expect(ok).toBe(true);
    }
    const pricing = await w.shotOf(w.feature.id, "pricing");
    const fresh = await get(w.deps, `/api/v1/snapshots/${pricing.id}`, w.ada);
    expect(fresh.body.snapshot.images).toMatchObject({ baseline: null, diff: null });
  });

  test("a snapshot of another project is a 404 for a CI token and for an outsider", async () => {
    const w = await world();
    const home = await w.shotOf(w.otherBuild.id, "home");
    expect((await get(w.deps, `/api/v1/snapshots/${home.id}`, w.acme.token)).status).toBe(404);
    expect((await get(w.deps, `/api/v1/snapshots/${home.id}`, w.eve)).status).toBe(404);
    expect((await get(w.deps, `/api/v1/snapshots/${home.id}`, w.other.token)).status).toBe(200);
  });

  test("detection flags: newest first, a page at a time, scoped to the project", async () => {
    const w = await world();
    const about = await w.shotOf(w.feature.id, "about");
    const home = await w.shotOf(w.feature.id, "home");
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    await flagSnapshot(w.db, {
      userId: w.userId,
      projectId: w.projectId,
      snapshotId: home.id,
      kind: "missed",
      note: "button moved",
      rect,
    });
    await flagSnapshot(w.db, {
      userId: w.userId,
      projectId: w.projectId,
      snapshotId: about.id,
      kind: "false_positive",
      note: null,
      rect: null,
    });
    const path = `/api/v1/projects/${w.projectId}/detection-flags`;
    const all = await get(w.deps, path, w.acme.token);
    expect(all.status).toBe(200);
    expect(all.body.detection_flags).toHaveLength(2);
    const homeFlag = all.body.detection_flags.find(
      (f: { snapshot: { id: string } }) => f.snapshot.id === home.id,
    );
    expect(homeFlag).toMatchObject({
      kind: "missed",
      note: "button moved",
      rect: { x: 1, y: 2, w: 3, h: 4 },
      by: "ada",
      build: { id: w.feature.id, branch: "feature", commit_sha: sha(2) },
      measured: { diff_status: "unchanged", changed_pixels: 0 },
      images: { head: expect.stringContaining("/images/") },
    });
    const first = await get(w.deps, `${path}?limit=1`, w.ada);
    expect(first.body.detection_flags).toHaveLength(1);
    const second = await get(w.deps, `${path}?limit=1&cursor=${first.body.next_cursor}`, w.ada);
    expect(second.body.detection_flags).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
    expect(second.body.detection_flags[0]?.id).not.toBe(first.body.detection_flags[0]?.id);
    const other = `/api/v1/projects/${w.other.project.id}/detection-flags`;
    expect((await get(w.deps, other, w.acme.token)).status).toBe(404);
    expect((await get(w.deps, path, w.eve)).status).toBe(404);
  });
});
