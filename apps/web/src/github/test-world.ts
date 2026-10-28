import { eq } from "drizzle-orm";
import type { ApiDeps } from "#/api/handler";
import { META, call, idOf, newBuild, setup, snapshotForm } from "#/api/test-support";
import { setGithubRepo } from "#/db/orgs";
import { decideShot } from "#/db/review";
import { builds, snapshots } from "#/db/schema";
import { RED, shot } from "#/diff/test-shots";
import { syncCheckRuns } from "./check-run";
import { fakeGithub } from "./test-github";

/** A server, a project on `acme/web` and a stand-in GitHub, for the check run and status tests. Tests only. */

const PUBLIC_URL = "https://pixelslash.test/";
export const PLAIN = shot({});
export const CHANGED = shot({ blocks: [{ x: 40, y: 40, w: 120, h: 80, rgb: RED }] });

export async function world({
  repo = "acme/web",
  app = true,
  token = false,
}: { repo?: string | null; app?: boolean; token?: boolean } = {}) {
  const held = await setup();
  const github = fakeGithub();
  const { project, user } = held.acme;
  if (repo) await setGithubRepo(held.db, user.id, project.id, repo);
  const checkRuns = {
    app: app ? github.app({ timeoutMs: 50 }) : null,
    token: token ? github.token({ timeoutMs: 50 }) : null,
    publicUrl: PUBLIC_URL,
  };
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
