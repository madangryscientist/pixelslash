import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * What a snapshot was rendered by. Only snapshots with equal fingerprints are
 * compared: a new image, browser or font set means a re-baseline, not a wall of diffs.
 */
export type Fingerprint = {
  /** `sha256:…` when the run is given its image digest, `version:…` inside an unpublished image, else `bare`. */
  image: string;
  /** e.g. `chromium 148.0.7778.5`. */
  browser: string;
  /** `sha256:…` over every font file fontconfig can see (path + bytes), or `unknown` without fontconfig. */
  fonts: string;
};

export const BARE = "bare";

/** The image part of the fingerprint, from the env the pinned image sets. */
export function imageId(env: NodeJS.ProcessEnv): string {
  const digest = env.PIXELSLASH_IMAGE_DIGEST;
  if (digest) return digest;
  const version = env.PIXELSLASH_IMAGE_VERSION;
  return version ? `version:${version}` : BARE;
}

/** Lists the font files fontconfig resolves, one path per line. Swapped in tests. */
export type ListFonts = () => Promise<string[] | undefined>;

export const fcList: ListFonts = () =>
  new Promise((resolve) => {
    const proc = spawn("fc-list", ["--format", "%{file}\\n"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => (out += chunk));
    // No fc-list on PATH is an `error` event (ENOENT), not a throw.
    proc.on("error", () => resolve(undefined));
    proc.on("close", (code) => resolve(code === 0 ? out.split("\n").filter(Boolean) : undefined));
  });

/** Hash the font set: sorted unique paths, each followed by its bytes. */
export async function fontSetHash(listFonts: ListFonts = fcList): Promise<string> {
  const files = await listFonts();
  if (!files) return "unknown";
  const hasher = createHash("sha256");
  for (const path of [...new Set(files)].toSorted()) {
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes) continue;
    hasher.update(`${path}\0`);
    hasher.update(bytes);
  }
  return `sha256:${hasher.digest("hex")}`;
}
