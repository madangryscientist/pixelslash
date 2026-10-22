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
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { authorize } from "./authorize";
import { flakeFields, listFlakes, resolveProjectFlake } from "./flakes";
import { type BaselinesCtx, buildBaselines, previewBaselines } from "./baselines";
import {
  API_VERSION,
  type ReadCtx,
  getBuild,
  getSnapshot,
  listBuilds,
  listDetectionFlags,
  listProjects,
  markDetectionFlagExported,
} from "./read";
import {
  BadRequest,
  Forbidden,
  MAX_FLAKE_RUNS,
  isPng,
  object,
  parseCiInput,
  parseFinalise,
  parseNewBuild,
  parseSnapshotInput,
  pngSize,
} from "./validate";

export type ApiDeps = {
  db: Db;
  store: BlobStore;
  /** Signs the image URLs the read API returns; read only when one is. */
  imageSecret: () => string;
  /** The oldest CLI (`x.y.z`) this server takes; unset takes any. */
  minCliVersion?: string | undefined;
  /** The engine's diff for finalise; a test passes one that throws (ob 1727). */
  diff?: ProcessDeps["diff"];
  /** The transport to a project's model after the diff (ob 1473); a test passes a stub. */
  modelFetch?: ProcessDeps["modelFetch"];
};

/** A PNG over this is refused before it is read; a full-page shot is a few MB. */
export const MAX_PNG_BYTES = 32 * 1024 * 1024;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

/** One part of a snapshot upload: a PNG no larger than MAX_PNG_BYTES. */
async function pngPart(form: FormData, field: string): Promise<ArrayBuffer> {
  const file = form.get(field);
  if (!(file instanceof File)) throw new BadRequest(`${field} must be a PNG upload`);
  if (file.size > MAX_PNG_BYTES) throw new TooLarge();
  const png = await file.arrayBuffer();
  if (!isPng(png)) throw new BadRequest(`${field} is not a PNG`);
  return png;
}

/**
 * Multipart: `meta` (JSON) and `file` (the PNG). In a `ci` project `meta.ci` carries the CLI's
 * results, and each needs its diff mask as `diff:<baselineId>`; the shot, plus at most two masks.
 * A flaky shot (ob 1737) adds `meta.flake` and its re-captures as `flake:<run>`, at most
 * MAX_FLAKE_RUNS - 1 of them; `meta.flaky` is the shot's policy (ob 1724).
 */
async function snapshotForm(request: Request, project: { diffLocation: DiffLocation }) {
  const pngs = (project.diffLocation === "ci" ? 3 : 1) + MAX_FLAKE_RUNS - 1;
  if (Number(request.headers.get("content-length")) > pngs * MAX_PNG_BYTES + 64 * 1024)
    throw new TooLarge();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new BadRequest("body must be multipart/form-data");
  }
  const meta = form.get("meta");
  if (typeof meta !== "string") throw new BadRequest("meta must be a JSON field");
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    throw new BadRequest("meta must be JSON");
  }
  const fields = object(parsed, "meta");
  const { flaky, flake } = await flakeFields(form, fields, MAX_PNG_BYTES);
  const input = { ...parseSnapshotInput(parsed), flaky };
  const png = await pngPart(form, "file");
  // A server project measures at finalise: results sent to it are not stored, so none is trusted.
  const sent = project.diffLocation === "ci" ? parseCiInput(fields.ci) : null;
  if (!sent) return { input, png, ci: null, flake };
  const results = await Promise.all(
    sent.results.map(async (r) => ({ ...r, mask: await pngPart(form, `diff:${r.baselineId}`) })),
  );
  const image = pngSize(png);
  return { input, png, ci: { engineVersion: sent.engineVersion, image, results }, flake };
}

class TooLarge extends Error {}

type Ctx = ApiDeps & { actor: Actor; request: Request };

/** A CI token's build goes to its project; a personal token names one it can see in `projectId`. */
function projectIdOf(body: unknown, actor: Actor): string {
  const named = object(body, "body").projectId;
  if (named !== undefined && typeof named !== "string")
    throw new BadRequest("projectId must be a string");
  if (actor.kind === "ci") return named ?? actor.projectId;
  if (!named) throw new BadRequest("projectId is required with a personal token");
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
  const done = await finaliseBuild(ctx.db, build, parseFinalise(await jsonBody(ctx.request)));
  // The diff runs here, in the request: inline for beta, no Queue (the map's server diff). One
  // whole-page change at 1280x4000 fits the 30 s CPU limit; several do not, and processBuild stops
  // before the limit and ends the build `errored` with a reason that names it, so the reply carries
  // `error`, and `unmeasured` counts the shots still to measure. A finalise sent again resumes: it keeps
  // what was measured and diffs the rest (ob 1645), which the CLI does by itself while `unmeasured` falls.
  // A kill by the runtime itself is not caught here; the build reads `processing` until it is older than
  // STALE_PROCESSING_MS, and a finalise sent again after that re-runs it (ob 1545). So does one sent
  // after `errored`.
  const blobs = orgBlobs(ctx.store, orgId);
  const result = await processBuild(
    { db: ctx.db, blobs, diff: ctx.diff, modelFetch: ctx.modelFetch },
    done,
  );
  return json({
    id: done.id,
    status: result.status,
    error: result.error,
    unmeasured: result.unmeasured,
  });
}

/** Who the token is: a person's login, or a CI token's project. What the CLI and MCP check a token with. */
async function me(ctx: Ctx): Promise<Response> {
  if (ctx.actor.kind === "ci") return json({ kind: "ci", projectId: ctx.actor.projectId });
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
  if (
    e instanceof BuildFinalisedError ||
    e instanceof SnapshotCountError ||
    e instanceof NoRecoveryError
  )
    return { status: 409, code: "conflict", message: e.message };
  if (e instanceof TooLarge)
    return { status: 413, code: "too_large", message: `PNG over ${MAX_PNG_BYTES} bytes` };
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
 * `authorize` turns the token into an actor: a CI token reaches its one project, a personal
 * (`psu_`) token every project of its user's orgs. A project, build or shot the actor cannot reach
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
