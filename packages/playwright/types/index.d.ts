// The declarations `dist/index.d.ts` ships. The bundle has the engine inlined, so its types cannot
// point at `@pixelslash/engine`; this file restates the public surface, and `test/types.ts` fails the
// typecheck when it and `src/index.ts` drift apart.
import type { Page } from "@playwright/test";

/** Add as an init script before pausing the page clock, so the settle keeps real frames. */
export function keepNativeRaf(): void;

export type SnapshotOptions = {
  /** Selectors the diff skips. Measured at the screenshot as boxes in image px; the pixels stay. */
  ignore?: string[];
  /** Selectors painted over in the PNG (`#FF00FF`), so what they show never leaves the machine. */
  redact?: string[];
  /** The variant's name, and the PNG's file name. Default `<width>x<height>-<theme>`. */
  variant?: string;
  tags?: string[];
  /** Default true, as `pixelslash capture` shoots. */
  fullPage?: boolean;
  /** Default `PIXELSLASH_SNAPSHOT_DIR`, else `pixelslash-snapshots` in the working dir. */
  dir?: string;
  /** Bounds the settle (fonts, images, network idle, two frames). Default 8000. */
  timeoutMs?: number;
};

/** The entry `snapshot()` wrote to `manifest.json`. */
export type SnapshotEntry = {
  name: string;
  path: string;
  variant: {
    name: string;
    browser: "chromium" | "firefox" | "webkit";
    viewport: { width: number; height: number };
    theme: "light" | "dark";
  };
  tags: string[];
  diff: Record<string, unknown>;
  /** Boxes the diff skips, in image px. */
  ignore: { x: number; y: number; width: number; height: number }[];
  flaky: string;
  /** Relative to the snapshot dir. */
  file: string;
  fingerprint: { image: string; browser: string; fonts: string };
};

/**
 * Screenshot `page` as the snapshot `name` into the snapshot dir and add it to the dir's
 * `manifest.json`, which `pixelslash upload` takes as it is.
 */
export function snapshot(page: Page, name: string, opts?: SnapshotOptions): Promise<SnapshotEntry>;
