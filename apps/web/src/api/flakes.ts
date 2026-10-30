import { actorProject } from "#/db/actor";
import { NotFoundError } from "#/db/db";
import {
  type ProjectFlake,
  type SentFlake,
  flakeProjectId,
  projectFlake,
  projectFlakes,
  resolveFlake,
} from "#/db/flakes";
import { type ReadCtx, imageUrl, iso, regionOf, reply, snapshotUrl } from "./read";
import { BadRequest, Forbidden, isPng, object, parseFlake, parseFlaky } from "./validate";

/**
 * Flakes over the API (ob 1724): any token that reaches the project lists them; only a person
 * resolves one, so `resolved_by` names who did. A CI token gets 403 on resolve.
 */

/** A flake's re-capture, `flake:<run>`: one that is missing, too big or not a PNG is left out. */
async function flakePart(
  form: FormData,
  run: number,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const file = form.get(`flake:${run}`);
  if (!(file instanceof File) || file.size > maxBytes) return null;
  const png = await file.arrayBuffer();
  return isPng(png) ? png : null;
}

/** `meta.flake` and the re-captures it names, or null when the record does not check out. */
async function sentFlake(
  form: FormData,
  raw: unknown,
  maxBytes: number,
): Promise<SentFlake | null> {
  const record = parseFlake(raw);
  if (!record) return null;
  const runs = Array.from({ length: record.runs - 1 }, (_, i) => i + 2);
  const captures = await Promise.all(
    runs.map(async (run) => ({ run, png: await flakePart(form, run, maxBytes) })),
  );
  return {
    record,
    captures: captures.flatMap(({ run, png }) => (png ? [{ run, png }] : [])),
  };
}

/** `meta.flaky`, the shot's policy, and `meta.flake` with its re-captures; garbage is dropped. */
export async function flakeFields(form: FormData, meta: Record<string, unknown>, maxBytes: number) {
  return { flaky: parseFlaky(meta.flaky), flake: await sentFlake(form, meta.flake, maxBytes) };
}

const MAX_NOTE = 200;

async function flakeOf(ctx: ReadCtx, projectId: string, orgId: string, f: ProjectFlake) {
  return {
    id: f.id,
    name: f.name,
    platform: f.platform,
    browser: f.browser,
    viewport: f.viewport,
    theme: f.theme,
    status: f.status,
    note: f.note,
    created_by: f.createdBy,
    created_at: iso(f.createdAt),
    resolved_by: f.resolvedBy,
    resolved_at: iso(f.resolvedAt),
    resolution_note: f.resolutionNote,
    updated_at: iso(f.updatedAt),
    evidence: await Promise.all(
      f.evidence.map(async (e) => ({
        build_id: e.buildId,
        snapshot_id: e.snapshotId,
        runs: e.runs,
        differed: e.differed,
        regions: e.regions.map((r) => ({ run: r.run, regions: r.regions.map(regionOf) })),
        engine_version: e.engineVersion,
        policy: e.policy,
        at: new Date(e.at).toISOString(),
        images: {
          head: await imageUrl(ctx, orgId, e.imageKey),
          runs: await Promise.all(
            e.captures.map(async (c) => ({ run: c.run, url: await imageUrl(ctx, orgId, c.key) })),
          ),
        },
        web_url: snapshotUrl(ctx, projectId, e.buildId, e.snapshotId),
      })),
    ),
  };
}

export type ApiFlake = Awaited<ReturnType<typeof flakeOf>>;

export async function listFlakes(ctx: ReadCtx, projectId: string): Promise<Response> {
  const project = await actorProject(ctx.db, ctx.actor, projectId);
  const rows = await projectFlakes(ctx.db, project.id);
  return reply({
    flakes: await Promise.all(rows.map((f) => flakeOf(ctx, project.id, project.orgId, f))),
    next_cursor: null,
  });
}

/** `{ note? }`: why it is resolved, at most MAX_NOTE characters; empty is no note. */
function noteOf(body: unknown): string | null {
  const note = object(body, "body").note ?? null;
  if (note !== null && (typeof note !== "string" || note.length > MAX_NOTE))
    throw new BadRequest(`note must be a string of at most ${MAX_NOTE} characters`);
  return note?.trim() || null;
}

export async function resolveProjectFlake(
  ctx: ReadCtx,
  flakeId: string,
  body: unknown,
): Promise<Response> {
  if (ctx.actor.kind !== "user") throw new Forbidden("a CI token cannot resolve a flake");
  const project = await actorProject(
    ctx.db,
    ctx.actor,
    await flakeProjectId(ctx.db, flakeId),
  ).catch((e: unknown) => {
    // Another org's flake is the same 404 as a missing one.
    throw e instanceof NotFoundError ? new NotFoundError("flake") : e;
  });
  const note = noteOf(body);
  await resolveFlake(ctx.db, { projectId: project.id, flakeId, userId: ctx.actor.userId, note });
  const done = await projectFlake(ctx.db, project.id, flakeId);
  if (!done) throw new Error(`flake ${flakeId} missing after resolve`);
  return reply({ flake: await flakeOf(ctx, project.id, project.orgId, done) });
}
