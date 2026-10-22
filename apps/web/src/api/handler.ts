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
  BadRequest,
  isPng,
  object,
  parseFinalise,
  parseNewBuild,
  parseSnapshotInput,
} from "./validate";

export type ApiDeps = { db: Db; store: BlobStore };

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

async function route(ctx: Ctx, parts: string[]): Promise<Response> {
  const [resource, ...rest] = parts;
  if (resource === "me" && rest.length === 0)
    return ctx.request.method === "GET" ? me(ctx) : fail(405, "method not allowed");
  if (resource === "builds" && rest.length <= 2) return routeBuilds(ctx, rest);
  return fail(404, "not found");
}

async function routeBuilds(ctx: Ctx, [buildId, action]: string[]): Promise<Response> {
  const is = (method: string) => ctx.request.method === method;
  if (!buildId) return is("POST") ? startBuild(ctx) : fail(405, "method not allowed");
  const { build, orgId } = await actorBuild(ctx.db, ctx.actor, buildId);
  if (action === "snapshots")
    return is("PUT") ? addSnapshot(ctx, build, orgId) : fail(405, "method not allowed");
  if (action === "finalize")
    return is("POST") ? closeBuild(ctx, build, orgId) : fail(405, "method not allowed");
  return fail(404, "not found");
}

function errorResponse(e: unknown): Response {
  if (e instanceof BadRequest) return fail(400, e.message);
  if (e instanceof NotFoundError) return fail(404, e.message);
  if (e instanceof BuildFinalisedError || e instanceof SnapshotCountError)
    return fail(409, e.message);
  if (e instanceof TooLarge) return fail(413, `PNG over ${MAX_PNG_BYTES} bytes`);
  throw e;
}

/**
 * The upload API, `/api/v1/…`, as a plain Request → Response so tests and the Worker route
 * share it. `authorize` turns the token into an actor: a CI token reaches its one project, a
 * personal (`psu_`) token every project of its user's orgs. A build of a project the actor
 * cannot reach is a 404, never a 403, and nothing it writes leaves that project's org.
 *
 *   GET  /api/v1/me                         → {kind: "user", user: {id, login, name}} | {kind: "ci", projectId}
 *   POST /api/v1/builds                     {commitSha, branch, mergeBaseSha?, ancestorShas?, prNumber?, projectId?} → {id}
 *                                           (`projectId` is required with a personal token)
 *   PUT  /api/v1/builds/:id/snapshots       multipart: meta (JSON), file (PNG) → {id}
 *   POST /api/v1/builds/:id/finalize        {snapshots: N} → {id, status, error, unmeasured}: diffs, then the build status
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(2);
  const actor = await authorize({ db: deps.db, request });
  if (!actor) return fail(401, "missing, wrong, expired or revoked token");
  try {
    return await route({ ...deps, actor, request }, parts);
  } catch (e) {
    return errorResponse(e);
  }
}
