import { blobStore } from "./env";
import { loadMetrics } from "./metrics-read";

/** `loadMetrics` against the deployment's own bucket. */
export const snapshotMetrics = (orgId: string, key: string | null) =>
  loadMetrics(blobStore(), orgId, key);
