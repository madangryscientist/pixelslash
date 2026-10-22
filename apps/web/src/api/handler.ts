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
import { processBuild } from "#/diff/process";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { authorize } from "./authorize";
import {
  API_VERSION,
  type ReadCtx,
  getBuild,
  getSnapshot,
  listBuilds,
  listDetectionFlags,
  listProjects,
} from "./read";
import {
  BadRequest,
  isPng,
  object,
  parseFinalise,
  parseNewBuild,
  parseSnapshotInput,
} from "./validate";

export type ApiDeps = {
  db: Db;
  store: BlobStore;
  /** Signs the image URLs the read API returns; read only when one is. */
  imageSecret: () => string;
  /** The oldest CLI (`x.y.z`) this server takes; unset takes any. */
  minCliVersion?: string | undefined;
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

/** Multipart: `meta` (JSON) and `file` (the PNG). */
async function snapshotForm(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_PNG_BYTES + 64 * 1024)
    throw new TooLarge();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new BadRequest("body must be multipart/form-data");
  }
  const meta = form.get("meta");
  const file = form.get("file");
  if (typeof meta !== "string") throw new BadRequest("meta must be a JSON field");
  if (!(file instanceof File)) throw new BadRequest("file must be a PNG upload");
  if (file.size > MAX_PNG_BYTES) throw new TooLarge();
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    throw new BadRequest("meta must be JSON");
  }
  const png = await file.arrayBuffer();
  if (!isPng(png)) throw new BadRequest("file is not a PNG");
  return { input: parseSnapshotInput(parsed), png };
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

async function startBuild(ctx: Ctx): Promise<Response> {
  const body = await jsonBody(ctx.request);
  const input = parseNewBuild(body);
  const project = await actorProject(ctx.db, ctx.actor, projectIdOf(body, ctx.actor));
  return json({ id: await createBuild(ctx.db, project.id, input) }, 201);
}

async function addSnapshot(ctx: Ctx, build: Build, orgId: string): Promise<Response> {
  const { input, png } = await snapshotForm(ctx.request);
  const blobs = orgBlobs(ctx.store, orgId);
  return json(await putSnapshot({ db: ctx.db, blobs }, build, input, png));
}

async function closeBuild(ctx: Ctx, build: Build, orgId: string): Promise<Response> {
  const done = await finaliseBuild(ctx.db, build, parseFinalise(await jsonBody(ctx.request)));
  // The diff runs here, in the request: inline for beta, no Queue (the map's server diff). One
  // whole-page change at 1280x4000 fits the 30 s CPU limit; several do not, and processBuild stops
  // before the limit and ends the build `errored` with a reason that names it, so the reply carries
  // `error`, and `unmeasured` counts the shots still to measure. A finalise sent again resumes: it keeps
  // what was measured and diffs the rest (ob 1645), which the CLI does by itself while `unmeasured` falls.
  // A kill by the runtime itself is not caught here; the build reads `processing` until it is older than
  // STALE_PROCESSING_MS, and a finalise sent again after that re-runs it (ob 1545). So does one sent
  // after `errored`.
  const result = await processBuild({ db: ctx.db, blobs: orgBlobs(ctx.store, orgId) }, done);
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

async function withBuild(
  ctx: Ctx,
  buildId: string,
  run: (build: Build, orgId: string) => Promise<Response>,
): Promise<Response> {
  const { build, orgId } = await actorBuild(ctx.db, ctx.actor, buildId);
  return run(build, orgId);
}

/** Every endpoint the API has. The README's API table is checked against this list. */
export const ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/v1/me", upload: true, run: (ctx) => me(ctx) },
  { method: "POST", path: "/api/v1/builds", upload: true, run: (ctx) => startBuild(ctx) },
  {
    method: "PUT",
    path: "/api/v1/builds/:id/snapshots",
    upload: true,
    run: (ctx, p) => withBuild(ctx, at(p, 0), (build, orgId) => addSnapshot(ctx, build, orgId)),
  },
  {
    method: "POST",
    path: "/api/v1/builds/:id/finalize",
    upload: true,
    run: (ctx, p) => withBuild(ctx, at(p, 0), (build, orgId) => closeBuild(ctx, build, orgId)),
  },
  { method: "GET", path: "/api/v1/projects", run: (ctx) => listProjects(reads(ctx)) },
  {
    method: "GET",
    path: "/api/v1/projects/:id/builds",
    run: (ctx, p) => listBuilds(reads(ctx), at(p, 0)),
  },
  {
    method: "GET",
    path: "/api/v1/projects/:id/detection-flags",
    run: (ctx, p) => listDetectionFlags(reads(ctx), at(p, 0)),
  },
  { method: "GET", path: "/api/v1/builds/:id", run: (ctx, p) => getBuild(reads(ctx), at(p, 0)) },
  {
    method: "GET",
    path: "/api/v1/snapshots/:id",
    run: (ctx, p) => getSnapshot(reads(ctx), at(p, 0)),
  },
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
  if (e instanceof BuildFinalisedError || e instanceof SnapshotCountError)
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
