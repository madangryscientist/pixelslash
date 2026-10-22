import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import { type DevStore, devStore } from "../src/dev-store.ts";
import type { CaptureSession } from "../src/snapshot.ts";

/** Fixtures for the `pixelslash dev` tests (ob 1740): a temp store and a browserless session. */

const temps: string[] = [];

export function cleanupDev(): void {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

export async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ps-dev-"));
  temps.push(dir);
  return dir;
}

export async function tmpStore(): Promise<DevStore> {
  return devStore(await tmpDir());
}

/** A 16x16 white PNG, with a red 4x6 block at (x, 4) when `at` is given. */
export function png(at?: number): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(255);
  if (at !== undefined)
    for (let y = 4; y < 10; y++)
      for (let x = at; x < at + 4; x++) img.data.set([220, 30, 30, 255], (y * 16 + x) << 2);
  return PNG.sync.write(img);
}

/** A session on one route whose page is whatever `page.at` says; each shot "settles" `settleMs`. */
export function fakeSession(settleMs = 40) {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:9",
    routes: ["/"],
    variants: [{ name: "small", viewport: { width: 16, height: 16 } }],
  });
  const page: { at: number | undefined; shots: number } = { at: undefined, shots: 0 };
  const session: CaptureSession = {
    config,
    routes: config.routes,
    fingerprint: { image: "version:test", browser: "chromium 1", fonts: "sha256:f" },
    shoot: async () => {
      page.shots++;
      await Bun.sleep(settleMs);
      return { png: png(page.at), ignore: [], settleMs };
    },
    close: async () => {},
  };
  return { session, page };
}
