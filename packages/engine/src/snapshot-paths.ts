import { resolve, sep } from "node:path";
import { UsageError } from "./errors.ts";
import type { SnapshotEntry } from "./snapshot.ts";

// `identity` and `pngPath` are all the Playwright helper takes from the manifest: they live apart from
// the parser so that its Node bundle does not drag the diff and the engine's package.json in with it.

/**
 * The identity the server keeps a snapshot under; two entries sharing it would overwrite each other.
 * A web entry's is what it always was; a native one names its platform and device (the renderer).
 */
export function identity(e: SnapshotEntry): string {
  const { width, height } = e.variant.viewport;
  const size = `${width}x${height}`;
  if (e.platform && e.device)
    return [e.name, e.platform, e.device, size, e.variant.theme].join(" / ");
  return [e.name, e.variant.browser, size, e.variant.theme].join(" / ");
}

/** A manifest names files relative to its dir; one that climbs out of it is refused. */
export function pngPath(dir: string, e: SnapshotEntry): string {
  const root = resolve(dir);
  const path = resolve(root, e.file);
  if (!path.startsWith(root + sep)) throw new UsageError(`manifest: ${e.file} is outside ${dir}`);
  return path;
}
