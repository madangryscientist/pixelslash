import { actorOrgs, actorProjects } from "#/db/actor";
import type { DiffLocation } from "#/db/schema";
import { ensureProject } from "#/db/orgs";
import { NotFoundError } from "#/db/db";
import { API_VERSION, type ReadCtx, projectOf } from "./read";
import { BadRequest, Forbidden, object, projectName } from "./validate";

type OrgRef = { id: string; name: string };

/** The org named by `asked` (id or name), else the actor's only one. */
function orgFor(orgs: OrgRef[], asked: string | undefined): OrgRef {
  if (asked !== undefined) {
    const byId = orgs.find((o) => o.id === asked);
    if (byId) return byId;
    const [named, ...others] = orgs.filter((o) => o.name === asked);
    if (!named) throw new NotFoundError("org");
    if (others.length > 0)
      throw new BadRequest(`more than one org is named "${asked}": pass its id`);
    return named;
  }
  const [only, ...rest] = orgs;
  if (only && rest.length === 0) return only;
  throw new BadRequest(
    only
      ? `org is required: you belong to ${orgs.map((o) => o.name).join(", ")}`
      : "you belong to no org",
  );
}

/**
 * `parent`, an id or the exact name of a top-level project in the org, as an id; absent is none.
 * A subproject's id is passed on, and `ensureProject` refuses it as a third level.
 */
async function parentFor(
  ctx: ReadCtx,
  orgId: string,
  parent: unknown,
): Promise<string | undefined> {
  if (parent === undefined) return undefined;
  if (typeof parent !== "string" || parent === "")
    throw new BadRequest("parent must be a project id or name");
  const inOrg = (await actorProjects(ctx.db, ctx.actor)).filter((p) => p.org.id === orgId);
  const hit =
    inOrg.find((p) => p.id === parent) ??
    inOrg.find((p) => p.parentId === null && p.name === parent);
  if (!hit) throw new NotFoundError("parent project");
  return hit.id;
}

/**
 * `POST /api/v1/projects` `{name, org?, parent?}` (ob 1787): the project of that name in an org, made if
 * there is none. 201 when made, 200 with the existing one, so a CI job can run it on every build.
 * An org token creates in its own org. A personal token in its one org, or the one `org` (id or
 * name) names when it belongs to several. A project's own `ci` token holds one project: a 403.
 * Nothing else makes a project, and an upload never does: a mistyped name stays a 404. With
 * `parent`, the project is a subproject of that top-level project, named uniquely under it.
 */
export async function createProjectByName(
  ctx: ReadCtx & { defaultDiffLocation: () => DiffLocation },
  body: unknown,
): Promise<Response> {
  if (ctx.actor.kind === "ci")
    throw new Forbidden(
      "a project's CI token cannot create projects; use an org or personal token",
    );
  const fields = object(body, "body");
  const name = projectName(fields.name);
  const asked = fields.org;
  if (asked !== undefined && typeof asked !== "string")
    throw new BadRequest("org must be a string");
  const target = orgFor(await actorOrgs(ctx.db, ctx.actor), asked);
  const parentId = await parentFor(ctx, target.id, fields.parent);
  const made = await ensureProject(ctx.db, target.id, {
    name,
    diffLocation: ctx.defaultDiffLocation(),
    parentId,
  });
  // Read back as the list reads it, so a subproject shows its parent's default branch.
  const project = (await actorProjects(ctx.db, ctx.actor)).find((p) => p.id === made.project.id);
  if (!project) throw new NotFoundError("project");
  return Response.json(
    { api_version: API_VERSION, ...projectOf(ctx, project), created: made.created },
    { status: made.created ? 201 : 200 },
  );
}
