import { UsageError } from "./errors.ts";
import { type Metrics, parseMetricsText } from "./metrics-entry.ts";
import { metricsPath } from "./snapshot-paths.ts";

/** A metrics file read from a snapshot dir: its bytes as they are (what is stored and sent) and what they parse to. */
export type MetricsFile = { bytes: Uint8Array; metrics: Metrics };

/**
 * Read and check the layout metrics file `file` names under `dir` (PS-294). Every refusal is a
 * `UsageError` that names the file, so `import`, `compare` and `upload` all exit 2 on it. The bytes
 * are kept as written: a higher minor version's extra fields travel with the file untouched.
 */
export async function readMetricsFile(dir: string, file: string): Promise<MetricsFile> {
  const path = metricsPath(dir, file);
  const handle = Bun.file(path);
  if (!(await handle.exists())) throw new UsageError(`manifest: ${file} does not exist`);
  return checkMetrics(file, new Uint8Array(await handle.arrayBuffer()));
}

/** The same check on bytes already in hand; `name` is what an error calls the file. */
export function checkMetrics(name: string, bytes: Uint8Array): MetricsFile {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const metrics = parseMetricsText(
    text,
    name,
    (where, what) => {
      throw new UsageError(`${where} ${what}`);
    },
    bytes.byteLength,
  );
  return { bytes, metrics };
}
