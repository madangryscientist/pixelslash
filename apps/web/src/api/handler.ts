import { type Actor, actorBuild, actorProject, actorUser } from "#/db/actor";
import {
  type Build,
  BuildFinalisedError,
  SnapshotCountError,
  createBuild,
  finaliseBuild,
  putSnapshot,
} from "#/db/builds";
import { type Db, NotFoundError } from "#/db/db";
import { NoRecoveryError, type ProcessDeps, processBuild } from "#/diff/process";
import type { DiffLocation } from "#/db/schema";
import { type CheckRunDeps, syncCheckRuns } from "#/github/check-run";
import { type RateLimiter, overApiLimit, retryAfter } from "#/server/rate-limit";
import { reportError } from "#/server/sentry";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { authorize, bearer } from "./authorize";
import { MAX_PNG_BYTES, TooLarge, snapshotForm } from "./snapshot-form";
import { createProjectByName } from "./project-create";
import { listFlakes, resolveProjectFlake } from "./flakes";
import { type BaselinesCtx, buildBaselines, previewBaselines } from "./baselines";
import {
  API_VERSION,
  type ReadCtx,
  buildUrl,
  getBuild,
  getSnapshot,
  listBuilds,
  listDetectionFlags,
  listProjects,
  markDetectionFlagExported,
} from "./read";
import { BadRequest, Forbidden, object, parseFinalise, parseNewBuild } from "./validate";
import { Unprocessable } from "./errors";

export type ApiDeps = {
  db: Db;
  store: BlobStore;
  /** Signs the image URLs the read API returns; read only when one is. */
  imageSecret: () => string;
  /** The oldest CLI (`x.y.z`) this server takes; unset takes any. */
  minCliVersion?: string | undefined;
  /** The engine's diff for finalise; a test passes one that throws (ob 1727). */
  diff?: ProcessDeps["diff"];
  /** The self-host's diff sidecar for finalise (PS-203); unset measures in-process. */
  diffSidecar?: ProcessDeps["diffSidecar"];
  /** Where a finalised build's changed shots go to be explained (ob 1875). */
  explainQueue?: ProcessDeps["explainQueue"];
  /** `MODEL_KEY_SECRET`, which opens the project's stored model key (ob 1786). */
  modelKeySecret?: ProcessDeps["modelKeySecret"];
  /** Where a project made through the API diffs (ob 1787). */
  defaultDiffLocation: () => DiffLocation;
  /** The GitHub App and public URL a finalised build's check run is synced with (PS-23); unset syncs none. */
  checkRuns?: Omit<CheckRunDeps, "db">;
  /** Counts requests per token, or per client IP when the token is refused (PS-250); unset counts none. */
  rateLimit?: RateLimiter | undefined;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

type Ctx = ApiDeps & { actor: Actor; request: Request };

/**
 * A CI token's build goes to its project; a personal or org token names one it can see in
 * `projectId`.
 */
function projectIdOf(body: unknown, actor: Actor): string {
  const named = object(body, "body").projectId;
  if (named !== undefined && typeof named !== "string")
    throw new BadRequest("projectId must be a string");
  if (actor.kind === "ci") return named ?? actor.projectId;
  if (!named)
    throw new BadRequest(
      `projectId is required with ${actor.kind === "org-ci" ? "an org" : "a personal"} token`,
    );
  return named;
}

/** Refused at the start of a `ci` project's build when the CLI does not diff (ob 1727). */
const UPGRADE_FOR_CI = "this project diffs in CI; upgrade the CLI";

/**
 * A CLI that diffs says so with `clientDiff: true`, and is told where its project diffs. One that
 * does not say so cannot send results, so a `ci` project refuses it before any shot is uploaded.
 */
async function startBuild(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx.request);
  const input = parseNewBuild(body);
  const project = await actorProject(ctx.db, ctx.actor, projectIdOf(body, ctx.actor));
  if (project.diffLocation === "ci" && object(body, "body").clientDiff !== true)
    return fail(426, UPGRADE_FOR_CI);
  const id = await createBuild(ctx.db, project.id, input);
  return json({ id, diffLocation: project.diffLocation }, 201);
}

async function addSnapshot(ctx: Ctx, build: Build, owner: BuildOwner): Promise<Response> {
  const sent = await snapshotForm(ctx.request, owner);
  const blobs = orgBlobs(ctx.store, owner.orgId);
  return json(await putSnapshot({ db: ctx.db, blobs }, build, sent));
}

async function closeBuild(ctx: Ctx, build: Build, { orgId }: BuildOwner): Promise<Response> {
  const { snapshots, timings } = parseFinalise(await jsonBody(ctx.request));
  const done = await finaliseBuild(ctx.db, build, snapshots, timings);
  // The diff runs here, in the request: inline for beta, no Queue (the map's server diff). One
  // whole-page change at 1280x4000 fits the 30 s CPU limit; several do not, and processBuild stops
  // before the limit and ends the build `errored` with a reason that names it, so the reply carries
  // `error`, and `unmeasured` counts the shots still to measure. A finalise sent again resumes: it keeps
  // what was measured and diffs the rest (ob 1645), which the CLI does by itself while `unmeasured` falls.
  // A kill by the runtime itself is not caught here; the build reads `processing` until it is older than
  // STALE_PROCESSING_MS, and a finalise sent again after that re-runs it (ob 1545). So does one sent
  // after `errored`.
  // The model's explanations are not in it: they are queued once the verdict is written (ob 1875).
  const blobs = orgBlobs(ctx.store, orgId);
  const { db, diff, diffSidecar, explainQueue, modelKeySecret } = ctx;
  // The check run says `in_progress` while the diff runs, then the verdict (PS-23); neither call
  // can fail the finalise.
  const sync = () => (ctx.checkRuns ? syncCheckRuns({ db, ...ctx.checkRuns }, [done.id]) : null);
  await sync();
  const result = await processBuild(
    { db, blobs, diff, diffSidecar, explainQueue, modelKeySecret },
    done,
  );
  await sync();
  return json({
    id: done.id,
    status: result.status,
    error: result.error,
    unmeasured: result.unmeasured,
    // For a CLI to point at an errored build (PS-228); absent from a server from before it.
    web_url: buildUrl({ origin: new URL(ctx.request.url).origin }, done.projectId, done.id),
  });
}

/** Who the token is: a person's login, a CI token's project, or an org token's org. What the CLI and MCP check a token with. */
async function me(ctx: Ctx): Promise<Response> {
  if (ctx.actor.kind === "ci") return json({ kind: "ci", projectId: ctx.actor.projectId });
  if (ctx.actor.kind === "org-ci") return json({ kind: "org-ci", orgId: ctx.actor.orgId });
  return json({ kind: "user", user: await actorUser(ctx.db, ctx.actor.userId) });
}

/**
 * One endpoint. `upload` marks the endpoints from before the read API (ob 1729): their errors stay
 * `{error: "…"}`, which the shipped CLI reads, and their replies carry no `api_version`. Every
 * other endpoint answers errors as `{error: {code, message}}`.
 */
type Endpoint = {
  method: "GET" | "POST" | "PUT";
  path: string;
  upload?: true;
  run: (ctx: Ctx, params: string[]) => Promise<Response>;
};

const reads = (ctx: Ctx): ReadCtx => ({
  db: ctx.db,
  actor: ctx.actor,
  origin: new URL(ctx.request.url).origin,
  imageSecret: ctx.imageSecret,
  query: new URL(ctx.request.url).searchParams,
});

const at = (params: string[], i: number) => params[i] ?? "";

/** A route whose one `:id` goes to a read with the token's actor. */
const byId =
  (read: (ctx: ReadCtx, id: string) => Promise<Response>): Endpoint["run"] =>
  (ctx, p) =>
    read(reads(ctx), at(p, 0));

const picks = (ctx: Ctx): BaselinesCtx => ({
  db: ctx.db,
  actor: ctx.actor,
  origin: new URL(ctx.request.url).origin,
  imageSecret: ctx.imageSecret,
});

/** The read-only pick: a CI token's own project, or the one a personal token names. */
async function preview(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx.request);
  return previewBaselines(picks(ctx), projectIdOf(body, ctx.actor), body);
}

/** The org a build's blobs live in, and where its project diffs. */
type BuildOwner = { orgId: string; diffLocation: DiffLocation };

async function withBuild(
  ctx: Ctx,
  buildId: string,
  run: (build: Build, owner: BuildOwner) => Promise<Response>,
): Promise<Response> {
  const { build, ...owner } = await actorBuild(ctx.db, ctx.actor, buildId);
  return run(build, owner);
}

/** Every endpoint the API has. The README's API table is checked against this list. */
export const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/v1/me", upload: true, run: (ctx) => me(ctx) },
  { method: "POST", path: "/api/v1/builds", upload: true, run: (ctx) => startBuild(ctx) },
  {
    method: "PUT",
    path: "/api/v1/builds/:id/snapshots",
    upload: true,
    run: (ctx, p) => withBuild(ctx, at(p, 0), (build, owner) => addSnapshot(ctx, build, owner)),
  },
  {
    method: "POST",
    path: "/api/v1/builds/:id/finalize",
    upload: true,
    run: (ctx, p) => withBuild(ctx, at(p, 0), (build, owner) => closeBuild(ctx, build, owner)),
  },
  {
    method: "POST",
    path: "/api/v1/builds/:id/baselines",
    run: async (ctx, p) => buildBaselines(picks(ctx), at(p, 0), await jsonBody(ctx.request)),
  },
  { method: "POST", path: "/api/v1/baselines", run: (ctx) => preview(ctx) },
  { method: "GET", path: "/api/v1/projects", run: (ctx) => listProjects(reads(ctx)) },
  {
    method: "POST",
    path: "/api/v1/projects",
    run: async (ctx) =>
      createProjectByName(
        { ...reads(ctx), defaultDiffLocation: ctx.defaultDiffLocation },
        await jsonBody(ctx.request),
      ),
  },
  { method: "GET", path: "/api/v1/projects/:id/builds", run: byId(listBuilds) },
  { method: "GET", path: "/api/v1/projects/:id/detection-flags", run: byId(listDetectionFlags) },
  {
    method: "POST",
    path: "/api/v1/detection-flags/:id/exported",
    run: byId(markDetectionFlagExported),
  },
  { method: "GET", path: "/api/v1/projects/:id/flakes", run: byId(listFlakes) },
  {
    method: "POST",
    path: "/api/v1/flakes/:id/resolve",
    run: async (ctx, p) => resolveProjectFlake(reads(ctx), at(p, 0), await jsonBody(ctx.request)),
  },
  { method: "GET", path: "/api/v1/builds/:id", run: byId(getBuild) },
  { method: "GET", path: "/api/v1/snapshots/:id", run: byId(getSnapshot) },
];

/** The `:param` values when `path` fits the pattern, else null. */
function match(pattern: string, path: string[]): string[] | null {
  const want = pattern.split("/").filter(Boolean);
  if (want.length !== path.length) return null;
  const params: string[] = [];
  for (const [i, part] of want.entries()) {
    const got = path[i] ?? "";
    if (part.startsWith(":")) {
      if (!got) return null;
      try {
        params.push(decodeURIComponent(got));
      } catch {
        return null;
      }
    } else if (part !== got) return null;
  }
  return params;
}

type ApiError = { status: number; code: string; message: string };

function errorOf(e: unknown): ApiError {
  if (e instanceof BadRequest) return { status: 400, code: "bad_request", message: e.message };
  if (e instanceof NotFoundError) return { status: 404, code: "not_found", message: e.message };
  if (e instanceof Forbidden) return { status: 403, code: "forbidden", message: e.message };
  if (e instanceof Unprocessable) return { status: 422, code: "unprocessable", message: e.message };
  if (
    e instanceof BuildFinalisedError ||
    e instanceof SnapshotCountError ||
    e instanceof NoRecoveryError
  )
    return { status: 409, code: "conflict", message: e.message };
  if (e instanceof TooLarge)
    return { status: 413, code: "too_large", message: `PNG over ${MAX_PNG_BYTES} bytes` };
  // Not one of the refusals above: a failed upload or finalise, which is the server's fault (PS-227).
  reportError(e, { area: "api" });
  throw e;
}

/** An upload endpoint's error is the string it always was; every other carries a code. */
function failWith(upload: boolean, { status, code, message }: ApiError): Response {
  if (upload) return fail(status, message);
  return json({ api_version: API_VERSION, error: { code, message } }, status);
}

/** `pixelslash/<x.y.z>`, the CLI's User-Agent; null for any other client. */
function cliVersion(request: Request): number[] | null {
  const found = /^pixelslash\/(\d+)\.(\d+)\.(\d+)/.exec(request.headers.get("user-agent") ?? "");
  return found ? found.slice(1).map(Number) : null;
}

/** True when the request is from a CLI older than `min` (`x.y.z`); other clients are never refused. */
function belowMinimum(request: Request, min: string | undefined): boolean {
  const have = cliVersion(request);
  const want = min?.split(".").map(Number);
  if (!have || !want || want.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i += 1) {
    const diff = (have[i] ?? 0) - (want[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

/**
 * The API, `/api/v1/…`, as a plain Request → Response so tests and the Worker route share it.
 * `authorize` turns the token into an actor: a CI token reaches its one project, an org (`psorg_`)
 * token every project of its org, a personal (`psu_`) token every project of its user's orgs. A project, build or shot the actor cannot reach
 * is a 404, never a 403, and nothing an upload writes leaves that project's org. The endpoints and
 * their replies are in `ENDPOINTS` and the README's "API" section.
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const path = new URL(request.url).pathname.split("/").filter(Boolean);
  const fits = ENDPOINTS.flatMap((e) => {
    const params = match(e.path, path);
    return params ? [{ endpoint: e, params }] : [];
  });
  const hit = fits.find(({ endpoint }) => endpoint.method === request.method);
  const upload = (hit ?? fits[0])?.endpoint.upload === true;
  if (belowMinimum(request, deps.minCliVersion))
    return failWith(upload, {
      status: 426,
      code: "cli_outdated",
      message: `upgrade the CLI: this server needs pixelslash ${deps.minCliVersion} or newer`,
    });
  const actor = await authorize({ db: deps.db, request });
  if (await overApiLimit(deps.rateLimit, request, actor && bearer(request)))
    return retryAfter(
      failWith(upload, {
        status: 429,
        code: "rate_limited",
        message: "too many requests: wait a minute and try again",
      }),
    );
  if (!actor)
    return failWith(upload, {
      status: 401,
      code: "unauthorized",
      message: "missing, wrong, expired or revoked token",
    });
  if (!hit) {
    if (fits.length > 0)
      return failWith(upload, {
        status: 405,
        code: "method_not_allowed",
        message: "method not allowed",
      });
    return failWith(false, { status: 404, code: "not_found", message: "not found" });
  }
  try {
    return await hit.endpoint.run({ ...deps, actor, request }, hit.params);
  } catch (e) {
    return failWith(upload, errorOf(e));
  }
}
