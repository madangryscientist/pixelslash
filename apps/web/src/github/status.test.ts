import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds } from "#/db/schema";
import { sha } from "#/diff/test-builds";
import type { StatusBody } from "./check-run";
import { type Call, TEST_TOKEN } from "./test-github";
import { CHANGED, PLAIN, world } from "./test-world";

/** The commit status a token-only server posts instead of a check run (PS-235). */

const statusBodies = (calls: Call[]) => calls.map((c): StatusBody => JSON.parse(c.raw));
const statusStates = (calls: Call[]) =>
  statusBodies(calls).map((b) => `${b.state} ${b.description}`);

describe("the PixelSlash commit status (token, no App)", () => {
  test("a build with nothing changed goes pending, then success, on its own commit", async () => {
    const w = await world({ app: false, token: true });
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });

    expect(main.body.status).toBe("passed");
    const posts = w.github.statusCalls();
    expect(posts.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /repos/acme/web/statuses/${sha(1)}`,
      `POST /repos/acme/web/statuses/${sha(1)}`,
    ]);
    expect(statusStates(posts)).toEqual(["pending Diffing the shots", "success No visual changes"]);
    const page = `https://pixelslash.test/projects/${w.acme.project.id}/builds/${main.id}`;
    expect(statusBodies(posts)[1]).toEqual({
      state: "success",
      context: "PixelSlash",
      description: "No visual changes",
      target_url: page,
    });
    // The token alone calls GitHub: no App traffic, no check run, nothing stored on the build.
    expect(w.github.calls.every((c) => c.auth === `Bearer ${TEST_TOKEN}`)).toBe(true);
    expect(w.github.checkRunCalls()).toEqual([]);
    expect((await w.buildRow(main.id))?.checkRunId).toBeNull();
  });

  test("a change is a failure until accepted, and a reject fails it again", async () => {
    const w = await world({ app: false, token: true });
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
    expect(statusStates(posts)).toEqual([
      "pending Diffing the shots",
      "failure 1 change to review",
      "success All changes accepted",
      "failure 1 change rejected",
    ]);
  });

  test("an errored build is a failure, and the description names the error", async () => {
    const w = await world({ app: false, token: true });
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.db
      .update(builds)
      .set({ status: "errored", error: "x".repeat(300) })
      .where(eq(builds.id, main.id));
    await w.sync([main.id]);
    const last = statusBodies(w.github.statusCalls()).at(-1);
    expect(last?.state).toBe("failure");
    expect(last?.description).toMatch(/^Build errored: x+$/);
    expect(last?.description.length).toBeLessThanOrEqual(140);
  });

  test("the App wins when both are configured: check runs only, no status", async () => {
    const w = await world({ token: true });
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    expect(main.body.status).toBe("passed");
    expect(w.github.checkRunCalls().length).toBe(2);
    expect(w.github.statusCalls()).toEqual([]);
    expect(w.github.calls.some((c) => c.auth === `Bearer ${TEST_TOKEN}`)).toBe(false);
  });

  test("with neither configured, or no repo, GitHub is not called", async () => {
    for (const setting of [{ app: false, token: false }, { repo: null }]) {
      const w = await world({ app: false, token: true, ...setting });
      const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
      expect(main.body.status).toBe("passed");
      expect(w.github.calls).toEqual([]);
    }
  });
});
