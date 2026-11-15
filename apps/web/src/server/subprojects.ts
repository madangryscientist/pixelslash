import { createServerFn } from "@tanstack/react-start";
import { createSubproject, listSubprojects } from "#/db/subprojects";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** A project's subprojects with their newest builds, for its page. */
export const getSubprojects = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(listSubprojects(database(), user.id, data.projectId));
  });

/** Add a subproject to a top-level project from its settings page; a name it has is kept. */
export const addSubproject = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ projectId: field(d, "projectId"), name: field(d, "name") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(createSubproject(database(), user.id, data.projectId, data.name));
  });
