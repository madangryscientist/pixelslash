import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { ApiDeps } from "#/api/handler";
import { META, call, idOf, newBuild, setup, snapshotForm } from "#/api/test-support";
import { setGithubRepo } from "#/db/orgs";
import { decideAll, decideShot } from "#/db/review";
import { builds, snapshots } from "#/db/schema";
import { sha } from "#/diff/test-builds";
import { RED, shot } from "#/diff/test-shots";
import { type CheckRunBody, syncCheckRuns } from "./check-run";
import { type Call, fakeGithub } from "./test-github";

/** The check run on a build's commit (PS-23), against a stand-in for GitHub's API. */

const PUBLIC_URL = "https://pixelslash.test/";
const PLAIN = shot({});
const CHANGED = shot({ blocks: [{ x: 40, y: 40, w: 120, h: 80, rgb: RED }] });

async function world({
  repo = "acme/web",
  app = true,
}: { repo?: string | null; app?: boolean } = {}) {
  const held = await setup();
  const github = fakeGithub();
  const { project, user } = held.acme;
  if (repo) await setGithubRepo(held.db, user.id, project.id, repo);
  const checkRuns = { app: app ? github.app({ timeoutMs: 50 }) : null, publicUrl: PUBLIC_URL };
  const deps: ApiDeps = { ...held.deps, checkRuns };
  const sync = (buildIds: string[]) => syncCheckRuns({ db: held.db, ...checkRuns }, buildIds);

  /** Open, fill and finalise one build over the API, as the CLI does; returns the reply. */
  async function finalise(spec: {
    commit: string;
    branch: string;
    mergeBase?: string;
    png: Uint8Array<ArrayBuffer>;
  }) {
    const opened = await call(
      deps,
      "POST /api/v1/builds",
      held.acme.token,
      newBuild({
        commitSha: spec.commit,
        branch: spec.branch,
        mergeBaseSha: spec.mergeBase ?? null,
      }),
    );
    const id = await idOf(opened);
    const form = snapshotForm({ ...META, ignore: [] }, spec.png);
    await call(deps, `PUT /api/v1/builds/${id}/snapshots`, held.acme.token, form);
    const res = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      held.acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    const body: { status: string; error: string | null } = await res.json();
    return { id, status: res.status, body };
  }

  const shotOf = async (buildId: string) => {
    const [row] = await held.db.select().from(snapshots).where(eq(snapshots.buildId, buildId));
    if (!row) throw new Error("no shot");
    return row;
  };
  const buildRow = async (id: string) =>
    (await held.db.select().from(builds).where(eq(builds.id, id)))[0];
  const decide = async (buildId: string, state: "accepted" | "rejected") =>
    (
      await decideShot(held.db, {
        projectId: project.id,
        snapshotId: (await shotOf(buildId)).id,
        state,
        userId: user.id,
      })
    ).buildIds;

  return { ...held, github, deps, sync, finalise, decide, buildRow };
}

const bodies = (calls: Call[]) => calls.map((c): CheckRunBody => JSON.parse(c.raw));
const states = (calls: Call[]) =>
  bodies(calls).map(
    (b) => `${b.status}${b.conclusion ? `:${b.conclusion}` : ""} ${b.output.title}`,
  );

describe("the PixelSlash check run", () => {
  test("a build with nothing changed goes in_progress, then success, on its own commit", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });

    expect(main.body.status).toBe("passed");
    const runs = w.github.checkRunCalls();
    expect(runs.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/check-runs",
      "PATCH /repos/acme/web/check-runs/100",
    ]);
    expect(states(runs)).toEqual([
      "in_progress Diffing the shots",
      "completed:success No visual changes",
    ]);
    const [created, done] = bodies(runs);
    expect(created).toMatchObject({ name: "PixelSlash", head_sha: sha(1), external_id: main.id });
    expect(done?.head_sha).toBeUndefined();
    const page = `https://pixelslash.test/projects/${w.acme.project.id}/builds/${main.id}`;
    expect(done?.details_url).toBe(page);
    expect(done?.output.summary).toContain(`[Review the build](${page})`);
    expect((await w.buildRow(main.id))?.checkRunId).toBe(100);
  });

  test("a change fails it until it is accepted, and a reject fails it again; one run, updated in place", async () => {
    const w = await world();
    await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    const before = w.github.checkRunCalls().length;
    const feature = await w.finalise({
      commit: sha(2),
      branch: "feat/x",
      mergeBase: sha(1),
      png: CHANGED,
    });
    expect(feature.body.status).toBe("changes");

    await w.sync(await w.decide(feature.id, "accepted"));
    await w.sync(await w.decide(feature.id, "rejected"));

    const runs = w.github.checkRunCalls().slice(before);
    expect(runs.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /repos/acme/web/check-runs",
      "PATCH /repos/acme/web/check-runs/101",
      "PATCH /repos/acme/web/check-runs/101",
      "PATCH /repos/acme/web/check-runs/101",
    ]);
    expect(states(runs)).toEqual([
      "in_progress Diffing the shots",
      "completed:failure 1 change to review",
      "completed:success All changes accepted",
      "completed:failure 1 change rejected",
    ]);
    expect(bodies(runs)[0]?.head_sha).toBe(sha(2));
    expect(bodies(runs)[1]?.output.summary).toContain("| 1 | 1 | 0 | 0 | 0 | 0 | 0 |");
    expect((await w.buildRow(feature.id))?.checkRunId).toBe(101);
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
    expect(states(w.github.checkRunCalls()).at(-1)).toBe("completed:success All changes accepted");
  });

  test("an errored build fails it, and the title names the error", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await w.db
      .update(builds)
      .set({ status: "errored", error: "the diff ran out of time" })
      .where(eq(builds.id, main.id));
    await w.sync([main.id]);
    const last = bodies(w.github.checkRunCalls()).at(-1);
    expect(last).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(last?.output.title).toBe("Build errored: the diff ran out of time");
  });

  test("a project with no repo, or a server with no App, calls GitHub not at all", async () => {
    for (const setting of [{ repo: null }, { app: false }]) {
      const w = await world(setting);
      const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
      expect(main.body.status).toBe("passed");
      expect(w.github.calls).toEqual([]);
      expect((await w.buildRow(main.id))?.checkRunId).toBeNull();
    }
  });

  test("a project moved to another repo gets a new run there, not a PATCH of the old one", async () => {
    const w = await world();
    const main = await w.finalise({ commit: sha(1), branch: "main", png: PLAIN });
    await setGithubRepo(w.db, w.acme.user.id, w.acme.project.id, "acme/site");
    expect((await w.buildRow(main.id))?.checkRunId).toBeNull();
    await w.sync([main.id]);
    const last = w.github.checkRunCalls().at(-1);
    expect(`${last?.method} ${last?.path}`).toBe("POST /repos/acme/site/check-runs");
    expect((await w.buildRow(main.id))?.checkRunId).toBe(101);
  });

  test.each([
    ["a 5xx", { status: 502 } as const],
    ["a timeout", "hang" as const],
  ])("%s from GitHub leaves the finalise reply and the verdict as they were", async (_, mode) => {
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
    expect((await w.buildRow(feature.id))?.checkRunId).toBeNull();
    await w.sync(await w.decide(feature.id, "accepted"));
    expect((await w.buildRow(feature.id))?.status).toBe("passed");

    // GitHub back: the next sync creates the run, with the state the build has now.
    w.github.setMode("ok");
    await w.sync([feature.id]);
    expect(states(w.github.checkRunCalls().slice(-1))).toEqual([
      "completed:success All changes accepted",
    ]);
  });
});
