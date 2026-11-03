import { createServerFn } from "@tanstack/react-start";
import { TwinProjectError, setTwinProject, twinCandidates } from "#/db/twins";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** The projects the settings page offers as a twin (PS-295): the org's others. */
export const getTwinOptions = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(twinCandidates(database(), user.id, data.projectId));
  });

/** The twin project (PS-295): another project of the org, or an empty id to clear it. */
export const saveTwinProject = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const twin = typeof d === "object" && d !== null ? Reflect.get(d, "twinProjectId") : null;
    if (twin !== null && typeof twin !== "string") throw new Error("twinProjectId is required");
    return { projectId: field(d, "projectId"), twinProjectId: twin === "" ? null : twin };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    try {
      await or404(setTwinProject(database(), user.id, data.projectId, data.twinProjectId));
    } catch (e) {
      // A server fn has no 400: the message is what the form shows.
      if (e instanceof TwinProjectError) throw new Error(e.message, { cause: e });
      throw e;
    }
  });
