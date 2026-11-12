import { sha256Hex } from "#/lib/crypto";

/** What names a snapshot within a build. */
export type StemKey = {
  buildId: string;
  name: string;
  platform: string;
  browser: string;
  viewport: string;
  theme: string;
};

/**
 * The blob prefix a shot owns: `builds/<buildId>/<identity>`, the identity being the first 32 hex
 * characters of the sha256 of its name and variant. Everything a shot writes of its own (its PNG
 * when it sent one, CI masks, metrics, flake captures, its diff overlay) sits beside this stem.
 * A shot stored by hash (PS-424) shares another build's `imageKey` but keeps its own stem, so what
 * it writes never lands on a key another build reads.
 */
export async function snapshotStem(key: StemKey): Promise<string> {
  const { name, platform, browser, viewport, theme } = key;
  const identity = await sha256Hex(JSON.stringify([name, platform, browser, viewport, theme]));
  return `builds/${key.buildId}/${identity.slice(0, 32)}`;
}
