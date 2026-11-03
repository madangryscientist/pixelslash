import { parseMetricsText, type Metrics } from "@hackcove/pixelslash-engine/metrics-entry";
import { orgBlobs, type BlobStore } from "#/storage/blobs";

/**
 * The layout metrics of a stored shot (PS-294, `docs/metrics.md`), or null when it has none. The
 * upload route validated the bytes, so a file that no longer reads (a blob lost to the retention
 * sweep, a reader that learned to refuse more) shows nothing rather than failing the shot's page.
 */
export async function loadMetrics(
  store: BlobStore,
  orgId: string,
  key: string | null,
): Promise<Metrics | null> {
  if (!key) return null;
  try {
    const body = await orgBlobs(store, orgId).get(key);
    if (!body) return null;
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    return parseMetricsText(new TextDecoder().decode(bytes), "metrics", fail, bytes.byteLength);
  } catch {
    return null;
  }
}

function fail(where: string, what: string): never {
  throw new Error(`${where} ${what}`);
}
