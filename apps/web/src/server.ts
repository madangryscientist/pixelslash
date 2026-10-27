import handler from "@tanstack/react-start/server-entry";
import { type ExplainDelivery, consumeExplain } from "#/ai/explain-queue";
import {
  blobStore,
  checkRunDeps,
  database,
  modelFetch,
  modelKeySecret,
  startRefusal,
} from "#/server/env";
import { withOptionalSentry } from "#/server/sentry";
import { orgBlobs } from "#/storage/blobs";

// A production build pointed at the GitHub stand-in does not start (PS-250): the throw fails the
// Worker's load, so `wrangler deploy` and the self-host's start stop with this message.
const refused = startRefusal();
if (refused) throw new Error(refused);

/**
 * The Worker's entry: TanStack Start's `fetch`, and the explain queue's consumer (ob 1875), which
 * explains each finalised build's changed shots with the project's model off the request. Both
 * report their errors to Sentry when `SENTRY_DSN` is set (PS-227) and run unwrapped when it is not.
 */
export default withOptionalSentry({
  fetch: (request) => handler.fetch(request),
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
