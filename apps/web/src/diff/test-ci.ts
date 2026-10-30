import {
  type BaselinePick,
  type CiResult,
  ENGINE_VERSION,
  measureShot,
} from "@hackcove/pixelslash-engine/ci-diff";
import type { DiffSummary } from "@hackcove/pixelslash-engine/diff";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { call, idOf, setup } from "#/api/test-support";
import type { ApiDeps } from "#/api/handler";
import { setDiffLocation } from "#/db/orgs";
import { builds, snapshots } from "#/db/schema";
import { sha } from "./test-builds";

/**
 * A project that diffs in CI (ob 1727), driven through the API as `pixelslash upload` drives it.
 * The CLI's half is the engine's own `measureShot` against the server's pick, so what a test
 * checks is what a real CLI sends.
 */

export const KEY = { name: "pricing", platform: "linux", browser: "chromium", viewport: "64x48" };
export const META = {
  ...KEY,
  theme: "light",
  tags: [],
  diff: {},
  ignore: [],
  fingerprint: { image: "version:1", browser: "chromium 148", fonts: "sha256:f" },
};

export type Held = Awaited<ReturnType<typeof setup>>;

/** The diff a `ci` finalise must never reach. */
export const noDiff = () => {
  throw new Error("the server diffed a ci build");
};

export type CiSent = { baselineId: string; status: string; diffResult: DiffSummary };

export type Run = {
  branch: string;
  commit: string;
  mergeBase?: string;
  png: Uint8Array<ArrayBuffer>;
  /** Replace what the CLI measured before it is sent; `undefined` sends no `ci` at all. */
  tamper?: ((results: CiSent[]) => CiSent[] | undefined) | undefined;
};

/** Read a signed image URL back out of the test's blob store, as the CLI fetches it. */
function fetcher(held: Held) {
  return async (picked: { image_url: string }) => {
    const key = decodeURIComponent(new URL(picked.image_url).pathname.replace(/^\/images\//, ""));
    const bytes = held.blobs.data.get(key);
    if (!bytes) throw new Error(`no blob at ${key}`);
    return Buffer.from(bytes);
  };
}

async function start(deps: ApiDeps, token: string, spec: Run): Promise<string> {
  const started = await call(
    deps,
    "POST /api/v1/builds",
    token,
    JSON.stringify({
      commitSha: spec.commit,
      branch: spec.branch,
      mergeBaseSha: spec.mergeBase ?? null,
      clientDiff: true,
    }),
  );
  expect(started.status).toBe(201);
  return idOf(started);
}

async function pickOf(deps: ApiDeps, token: string, buildId: string): Promise<BaselinePick> {
  const res = await call(
    deps,
    `POST /api/v1/builds/${buildId}/baselines`,
    token,
    JSON.stringify({ keys: [{ ...KEY, theme: "light" }] }),
  );
  expect(res.status).toBe(200);
  const body: { baselines: BaselinePick[] } = await res.json();
  const pick = body.baselines[0];
  if (!pick) throw new Error("no pick");
  return pick;
}

/** The upload's form: the shot, and what the CLI measured (after `tamper`) with each mask. */
function formOf(spec: Run, measured: CiResult[]): FormData {
  const sent: CiSent[] = measured.map(({ baselineId, status, diffResult }) => ({
    baselineId,
    status,
    diffResult,
  }));
  const results = spec.tamper ? spec.tamper(sent) : sent;
  const form = new FormData();
  const ci = results?.length ? { engineVersion: ENGINE_VERSION, results } : undefined;
  form.set("meta", JSON.stringify({ ...META, ...(ci && { ci }) }));
  form.set("file", new File([spec.png.slice()], "shot.png", { type: "image/png" }));
  // Each result sent carries the mask the CLI made for the one it replaced.
  for (const [i, r] of (results ?? []).entries()) {
    const mask = Uint8Array.from(measured[i]?.mask ?? []);
    form.set(`diff:${r.baselineId}`, new File([mask], "diff.png", { type: "image/png" }));
  }
  return form;
}

/** One build of one shot, as `pixelslash upload` makes it: start, pick, measure, send, finalise. */
export async function run(held: Held, token: string, spec: Run, deps: ApiDeps = held.deps) {
  const id = await start(deps, token, spec);
  const pick = await pickOf(deps, token, id);
  const measured = await measureShot(META, Buffer.from(spec.png), pick, fetcher(held));
  const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, formOf(spec, measured));
  expect(put.status).toBe(200);
  const done = await call(
    deps,
    `POST /api/v1/builds/${id}/finalize`,
    token,
    JSON.stringify({ snapshots: 1 }),
  );
  const [row] = await held.db.select().from(snapshots).where(eq(snapshots.buildId, id));
  if (!row) throw new Error("no shot");
  const [build] = await held.db.select().from(builds).where(eq(builds.id, id));
  return { id, done, row, build, pick, measured };
}

/** The `acme` project diffs in CI; `other` stays on the server. */
export async function ciProject() {
  const held = await setup();
  await setDiffLocation(held.db, held.acme.user.id, held.acme.project.id, "ci");
  return held;
}

export const branch = (commit: number, png: Uint8Array<ArrayBuffer>) => ({
  branch: "feat/x",
  commit: sha(commit),
  mergeBase: sha(1),
  png,
});
