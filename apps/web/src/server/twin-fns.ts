import { createServerFn } from "@tanstack/react-start";
import type { Db } from "#/db/db";
import { TwinProjectError, setTwinProject, twinCandidates } from "#/db/twins";
import type { User } from "#/db/users";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/*
 * Each server function here is a validator and a plain function of the store, the viewer and the
 * validated input, which the server function wraps. Outside the Start compiler (a Vitest run) a
 * `createServerFn` neither runs its validator nor returns its handler's result, so a route test
 * binds the plain halves to a temp store instead (`bindServerFn` in `src/test/render.tsx`).
 */

export const twinOptionsInput = (d: unknown) => ({ projectId: field(d, "projectId") });

/** The projects the settings page offers as a twin (PS-295): the org's others. */
export const twinOptions = (db: Db, user: User, data: ReturnType<typeof twinOptionsInput>) =>
  or404(twinCandidates(db, user.id, data.projectId));

export const getTwinOptions = createServerFn()
  .validator(twinOptionsInput)
  .handler(async ({ data }) => twinOptions(database(), await requireViewer(), data));

export function twinProjectInput(d: unknown) {
  const twin = typeof d === "object" && d !== null ? Reflect.get(d, "twinProjectId") : null;
  if (twin !== null && typeof twin !== "string") throw new Error("twinProjectId is required");
  return { projectId: field(d, "projectId"), twinProjectId: twin === "" ? null : twin };
}

/** The twin project (PS-295): another project of the org, or an empty id to clear it. */
export async function saveTwin(
  db: Db,
  user: User,
  data: ReturnType<typeof twinProjectInput>,
): Promise<void> {
  try {
    await or404(setTwinProject(db, user.id, data.projectId, data.twinProjectId));
  } catch (e) {
    // A server fn has no 400: the message is what the form shows.
    if (e instanceof TwinProjectError) throw new Error(e.message, { cause: e });
    throw e;
  }
}

export const saveTwinProject = createServerFn({ method: "POST" })
  .validator(twinProjectInput)
  .handler(async ({ data }) => saveTwin(database(), await requireViewer(), data));
