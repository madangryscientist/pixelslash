import { ENGINE_VERSION } from "@pixelslash/engine/ci-diff";
import { describe, expect, test } from "vitest";
import { call, setup } from "#/api/test-support";
import { getBuild } from "#/db/builds";
import { builds } from "#/db/schema";
import { orgBlobs } from "#/storage/blobs";
import { NoRecoveryError, processBuild } from "./process";
import { type Run, branch, ciProject, noDiff, run } from "./test-ci";
import { sha } from "./test-builds";
import { RED, shot } from "./test-shots";

/** A project that diffs in CI (ob 1727), end to end through the API (`test-ci.ts`). */

const white = shot();
const red = shot({ blocks: [{ x: 8, y: 8, w: 16, h: 12, rgb: RED }] });
const redder = shot({ blocks: [{ x: 4, y: 4, w: 24, h: 20, rgb: RED }] });

describe("a project that diffs in CI", () => {
  test("the CLI and the server reach the same results, carry included; only measured_by differs", async () => {
    const held = await ciProject();
    const ci = { ...held.deps, diff: noDiff };
    const sequence = [
      { branch: "main", commit: sha(1), png: white },
      branch(2, red), // changed against main
      branch(3, red), // identical to an undecided change: carries it
      branch(4, redder), // moved past the open change: measured against main's accepted shot
    ];
    const seen = [];
    for (const spec of sequence) {
      const onCi = await run(held, held.acme.token, spec, ci);
      const onServer = await run(held, held.other.token, spec);
      expect(onCi.done.status).toBe(200);
      // A shot with nothing to compare against is measured by no one.
      const measured = onServer.row.diffResult !== null;
      expect(onCi.row.measuredBy).toBe(measured ? "ci" : null);
      expect(onCi.row.engineVersion).toBe(measured ? ENGINE_VERSION : null);
      expect(onServer.row.measuredBy).toBe(measured ? "server" : null);
      const view = (r: typeof onCi) => ({
        build: r.build?.status,
        diffStatus: r.row.diffStatus,
        diffResult: r.row.diffResult,
        carries: r.row.carriedFrom !== null,
        reviewState: r.row.reviewState,
        baseline: r.row.baselineKey !== null,
      });
      expect(view(onCi)).toEqual(view(onServer));
      seen.push(view(onCi));
    }
    expect(seen.map((s) => [s.diffStatus, s.carries])).toEqual([
      ["new", false],
      ["changed", false],
      ["unchanged", true],
      ["changed", false],
    ]);
  });

  test("a ci build finalises without the server diff; a server build with no diff errors", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const ci = await run(held, held.acme.token, branch(2, red), deps);
    expect(ci.build?.status).toBe("changes");
    expect(ci.row.diffStatus).toBe("changed");

    await run(held, held.other.token, { branch: "main", commit: sha(1), png: white }, deps);
    const server = await run(held, held.other.token, branch(2, red), deps);
    expect(server.build?.status).toBe("errored");
  });

  test("a squash-merged main build is auto-accepted through CI (ob 1559)", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const squash = await run(
      held,
      held.acme.token,
      { branch: "main", commit: sha(2), png: red },
      deps,
    );
    expect(squash.row).toMatchObject({ diffStatus: "changed", reviewState: "accepted" });
    expect(squash.build?.status).toBe("passed");
  });

  const errors: [string, Run["tamper"], RegExp][] = [
    ["missing", () => undefined, /no result/],
    [
      "malformed",
      (rs) => rs.map((r) => ({ ...r, diffResult: { ...r.diffResult, changedPixels: -1 } })),
      /invalid result/,
    ],
    ["stale", (rs) => rs.map((r) => ({ ...r, baselineId: "an-older-baseline" })), /stale baseline/],
  ];
  for (const [what, tamper, reason] of errors) {
    test(`a ${what} result errors the shot by name and the build`, async () => {
      const held = await ciProject();
      const deps = { ...held.deps, diff: noDiff };
      await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
      const r = await run(held, held.acme.token, { ...branch(2, red), tamper }, deps);
      expect(r.measured).toHaveLength(1);
      expect(r.row.diffStatus).toBeNull();
      expect(r.row.diffError).toMatch(reason);
      expect(r.build?.status).toBe("errored");
      expect(r.build?.error).toMatch(/re-run the CI job/);
    });
  }

  test("an old CLI is refused by a ci project and accepted by a server one", async () => {
    const held = await ciProject();
    const body = JSON.stringify({ commitSha: sha(1), branch: "main" });
    const refused = await call(held.deps, "POST /api/v1/builds", held.acme.token, body);
    expect(refused.status).toBe(426);
    expect(await refused.json()).toEqual({
      error: "this project diffs in CI; upgrade the CLI",
    });
    expect(await held.db.select().from(builds)).toHaveLength(0);

    const accepted = await call(held.deps, "POST /api/v1/builds", held.other.token, body);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ diffLocation: "server" });
  });

  test("an errored ci build is not recovered: finalising it again is a 409", async () => {
    const held = await ciProject();
    const deps = { ...held.deps, diff: noDiff };
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white }, deps);
    const r = await run(
      held,
      held.acme.token,
      { ...branch(2, red), tamper: () => undefined },
      deps,
    );
    expect(r.build?.status).toBe("errored");

    const build = await getBuild(held.db, held.acme.project.id, r.id);
    await expect(
      processBuild(
        { db: held.db, blobs: orgBlobs(held.deps.store, held.acme.org.id), diff: noDiff },
        build,
      ),
    ).rejects.toBeInstanceOf(NoRecoveryError);
    const again = await call(
      deps,
      `POST /api/v1/builds/${r.id}/finalize`,
      held.acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(again.status).toBe(409);
  });

  test("results sent to a server project are not trusted: the server measures", async () => {
    const held = await setup();
    await run(held, held.acme.token, { branch: "main", commit: sha(1), png: white });
    const r = await run(held, held.acme.token, {
      ...branch(2, red),
      tamper: (rs) => rs.map((x) => ({ ...x, status: "unchanged" })),
    });
    expect(r.row).toMatchObject({ measuredBy: "server", diffStatus: "changed" });
  });
});
