import handler from "@tanstack/react-start/server-entry";
import { type ExplainDelivery, consumeExplain } from "#/ai/explain-queue";
import { blobStore, database, modelKeySecret } from "#/server/env";
import { orgBlobs } from "#/storage/blobs";

/**
 * The Worker's entry: TanStack Start's `fetch`, and the explain queue's consumer (ob 1875), which
 * explains each finalised build's changed shots with the project's model off the request.
 */
export default {
  fetch: handler.fetch,
  async queue(batch: { messages: readonly ExplainDelivery[] }): Promise<void> {
    const store = blobStore();
    const blobs = (orgId: string) => orgBlobs(store, orgId);
    await consumeExplain(
      { db: database(), blobs, modelKeySecret: modelKeySecret() },
      batch.messages,
    );
  },
};
