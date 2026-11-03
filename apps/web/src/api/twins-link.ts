import { actorProjects } from "#/db/actor";
import { NotFoundError } from "#/db/db";
import { TwinProjectError, setTwinProject } from "#/db/twins";
import { type ReadCtx, projectOf, reply } from "./read";
import { BadRequest, Forbidden, object } from "./validate";

/**
 * `PUT /api/v1/projects/:id/twin` (PS-295): name another project of the org as this one's twin,
 * or `null` to clear it. A person's token only, and only an org member (as for the settings page);
 * a project of another org, an unknown one or the project itself is a 400.
 */
export async function putProjectTwin(
  ctx: ReadCtx,
  projectId: string,
  body: unknown,
): Promise<Response> {
  if (ctx.actor.kind !== "user")
    throw new Forbidden("only a personal token can link a twin project");
  const sent = object(body, "body").twin_project_id;
  if (sent !== null && (typeof sent !== "string" || sent === ""))
    throw new BadRequest("twin_project_id must be a project id or null");
  try {
    await setTwinProject(ctx.db, ctx.actor.userId, projectId, sent);
  } catch (e) {
    if (e instanceof TwinProjectError) throw new BadRequest(e.message);
    throw e;
  }
  const project = (await actorProjects(ctx.db, ctx.actor)).find((p) => p.id === projectId);
  // setTwinProject proved the user is a member, so the project is among theirs.
  if (!project) throw new NotFoundError("project");
  return reply({ project: projectOf(ctx, project) });
}
