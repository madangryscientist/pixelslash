import handler from "@tanstack/react-start/server-entry";
import { type ExplainDelivery, consumeExplain } from "#/ai/explain-queue";
import {
  blobStore,
  checkRunDeps,
  database,
  modelFetch,
  modelKeySecret,
  retentionDays,
  retentionDelete,
  startRefusal,
  sweepStore,
} from "#/server/env";
import { withOptionalSentry } from "#/server/sentry";
import { sweepRetention } from "#/db/retention";
import { sweepSummary } from "#/lib/retention";
import { warn } from "#/lib/log";
import { orgBlobs, orgSweepBlobs } from "#/storage/blobs";

// A production build pointed at the GitHub stand-in does not start (PS-250): the throw fails the
// Worker's load, so `wrangler deploy` and the self-host's start stop with this message.
const refused = startRefusal();
if (refused) throw new Error(refused);

/** Builds one scheduled sweep takes, oldest first, so a first run on a long history stays short. */
const SWEEP_BATCH = 100;

/**
 * The Worker's entry: TanStack Start's `fetch`, the explain queue's consumer (ob 1875), which
 * explains each finalised build's changed shots with the project's model off the request, and the
 * retention sweep (PS-239), which does nothing until `PIXELSLASH_RETENTION_DAYS` is set and only logs
 * what it would delete until `PIXELSLASH_RETENTION_DELETE` is `true`. All report their errors to Sentry when `SENTRY_DSN` is set (PS-227) and run unwrapped when it is not.
 */
export default withOptionalSentry({
  fetch: (request) => handler.fetch(request),
  async scheduled(): Promise<void> {
    const days = retentionDays();
    if (days === undefined) return;
    const store = sweepStore();
    const { plan, result } = await sweepRetention(
      database(),
      (orgId) => orgSweepBlobs(store, orgId),
      { days, now: new Date(), limit: SWEEP_BATCH, dryRun: !retentionDelete() },
    );
    warn(sweepSummary(plan, result));
  },
  async queue(batch: { messages: readonly ExplainDelivery[] }): Promise<void> {
    const store = blobStore();
    const blobs = (orgId: string) => orgBlobs(store, orgId);
    const db = database();
    await consumeExplain(
      {
        db,
        blobs,
        modelKeySecret: modelKeySecret(),
        modelFetch: modelFetch(),
        checkRuns: checkRunDeps(db),
      },
      batch.messages,
    );
  },
});
