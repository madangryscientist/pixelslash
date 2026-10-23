import { createServerFn } from "@tanstack/react-start";
import { orgTimings } from "#/db/timings-stats";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/* The org's Timings page (ob 1792): p50 and p95 of each server step, per project. */

export const getOrgTimings = createServerFn()
  .validator((d: unknown) => ({ orgId: field(d, "orgId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(orgTimings(database(), user.id, data.orgId, new Date()));
  });
