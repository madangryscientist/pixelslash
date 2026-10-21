import { type Db, NotFoundError } from "#/db/db";
import {
  type Build,
  BuildFinalisedError,
  SnapshotCountError,
  createBuild,
  finaliseBuild,
  getBuild,
  putSnapshot,
} from "#/db/builds";
import { verifyCiToken } from "#/db/tokens";
import { processBuild } from "#/diff/process";
import { type BlobStore, orgBlobs } from "#/storage/blobs";
import { BadRequest, isPng, parseFinalise, parseNewBuild, parseSnapshotInput } from "./validate";

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

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

type Auth = { projectId: string; orgId: string };
type Ctx = ApiDeps & { auth: Auth; request: Request };

async function startBuild(ctx: Ctx): Promise<Response> {
  const input = parseNewBuild(await jsonBody(ctx.request));
  return json({ id: await createBuild(ctx.db, ctx.auth.projectId, input) }, 201);
}

async function addSnapshot(ctx: Ctx, build: Build): Promise<Response> {
  const { input, png } = await snapshotForm(ctx.request);
  const blobs = orgBlobs(ctx.store, ctx.auth.orgId);
  return json(await putSnapshot({ db: ctx.db, blobs }, build, input, png));
}

async function closeBuild(ctx: Ctx, build: Build): Promise<Response> {
  const done = await finaliseBuild(ctx.db, build, parseFinalise(await jsonBody(ctx.request)));
  // The diff runs here, in the request: inline for beta, no Queue (the map's server diff). One
  // whole-page change at 1280x4000 fits the 30 s CPU limit; several do not, and processBuild stops
  // before the limit and ends the build `errored` with a reason that names it, so the reply carries
  // `error`, and `unmeasured` counts the shots still to measure. A finalise sent again resumes: it keeps
  // what was measured and diffs the rest (ob 1645), which the CLI does by itself while `unmeasured` falls.
  // A kill by the runtime itself is not caught here; the build reads `processing` until it is older than
  // STALE_PROCESSING_MS, and a finalise sent again after that re-runs it (ob 1545). So does one sent
  // after `errored`.
  const result = await processBuild(
    { db: ctx.db, blobs: orgBlobs(ctx.store, ctx.auth.orgId) },
    done,
  );
  return json({
    id: done.id,
    status: result.status,
    error: result.error,
    unmeasured: result.unmeasured,
  });
}

async function route(ctx: Ctx, buildId?: string, action?: string): Promise<Response> {
  const is = (method: string) => ctx.request.method === method;
  if (!buildId) return is("POST") ? startBuild(ctx) : fail(405, "method not allowed");
  const build = await getBuild(ctx.db, ctx.auth.projectId, buildId);
  if (action === "snapshots")
    return is("PUT") ? addSnapshot(ctx, build) : fail(405, "method not allowed");
  if (action === "finalize")
    return is("POST") ? closeBuild(ctx, build) : fail(405, "method not allowed");
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
 * The CI upload API, `/api/v1/builds…`, as a plain Request → Response so tests and the
 * Worker route share it. A token authenticates one project; a build of any other project
 * (so any other org) is a 404, never a 403, and nothing it writes leaves the token's org.
 *
 *   POST /api/v1/builds                     {commitSha, branch, mergeBaseSha?, ancestorShas?, prNumber?} → {id}
 *   PUT  /api/v1/builds/:id/snapshots       multipart: meta (JSON), file (PNG) → {id}
 *   POST /api/v1/builds/:id/finalize        {snapshots: N} → {id, status, error, unmeasured}: diffs, then the build status
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(2);
  if (parts[0] !== "builds" || parts.length > 3) return fail(404, "not found");
  const token = bearer(request);
  const auth = token ? await verifyCiToken(deps.db, token) : null;
  if (!auth) return fail(401, "missing, wrong or revoked token");
  try {
    return await route({ ...deps, auth, request }, parts[1], parts[2]);
  } catch (e) {
    return errorResponse(e);
  }
}
