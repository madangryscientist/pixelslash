import { createServerFn } from "@tanstack/react-start";
import { listFlakes, markFlaky, setFlakeStatus } from "#/db/flakes";
import { getProjectWithOrg } from "#/db/orgs";
import { database, syncChecks } from "./env";
import { signedFlake } from "./flake-images";
import { field, noteInput, or404 } from "./input";
import { requireViewer } from "./session";

/* Flakes on the page (ob 1724): the snapshot page's panel, Mark flaky and the project's list. */

export type { FlakeView } from "./flake-images";

/** Mark a shot flaky by hand, with an optional note: its key's flake opens with no CLI evidence. */
export const markShotFlaky = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({
    projectId: field(d, "projectId"),
    snapshotId: field(d, "snapshotId"),
    note: noteInput(d),
  }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { buildId } = await or404(markFlaky(db, { ...data, userId: user.id }));
    await syncChecks(db, [buildId]);
  });

export const getFlakesPage = createServerFn()
  .validator((d: unknown) => ({ projectId: field(d, "projectId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const db = database();
    const { project, org } = await or404(getProjectWithOrg(db, user.id, data.projectId));
    const flakes = await listFlakes(db, user.id, project.id);
    return {
      org,
      project,
      flakes: await Promise.all(flakes.map((f) => signedFlake(project.orgId, f))),
      now: new Date(),
    };
  });

/** Resolve a flake with an optional note, or reopen it. */
export const saveFlakeStatus = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const open = typeof d === "object" && d !== null ? Reflect.get(d, "open") : null;
    if (typeof open !== "boolean") throw new Error("open is required");
    return {
      projectId: field(d, "projectId"),
      flakeId: field(d, "flakeId"),
      open,
      note: noteInput(d),
    };
  })
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(setFlakeStatus(database(), { ...data, userId: user.id }));
  });
