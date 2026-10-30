import { createFileRoute } from "@tanstack/react-router";
import { NotFoundError } from "#/db/db";
import { listFlags } from "#/db/flags";
import { getProjectWithOrg } from "#/db/orgs";
import { database } from "#/server/env";
import { viewer } from "#/server/session";

/**
 * A project's detection flags as JSON (ob 1721): the work list for the detector. Each flag carries
 * the three blob keys (inside `orgs/<orgId>/`) and its rect, enough to turn it into a bench case by
 * hand. Signed-out, missing and another org's project are the same 404.
 */
export const Route = createFileRoute("/projects/$projectId/flags.json")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const user = await viewer();
        if (!user) return new Response("not found", { status: 404 });
        const db = database();
        try {
          const { project, org } = await getProjectWithOrg(db, user.id, params.projectId);
          const flags = await listFlags(db, user.id, project.id);
          const body = {
            project: { id: project.id, name: project.name },
            orgId: org.id,
            exportedAt: new Date().toISOString(),
            flags,
          };
          return new Response(JSON.stringify(body, null, 2), {
            headers: {
              "content-type": "application/json",
              "content-disposition": `attachment; filename="detection-flags-${project.id}.json"`,
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          if (error instanceof NotFoundError) return new Response("not found", { status: 404 });
          throw error;
        }
      },
    },
  },
});
