import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diffPngs, type DiffIgnore, type DiffOptions, type IgnoreRect } from "./diff.ts";
import type { Region, Specks } from "./regions.ts";

export type RunManifest = {
  id: string;
  changedPixels: number;
  /** The one verdict: sizes differ, or a `change` region survives and clears the `diff` floors. */
  changed: boolean;
  /** Boxes of the changed pixels, largest first; `noise` ones do not make a run changed. */
  regions: Region[];
  /** Boxes dropped for being too small to be anything but a speck. */
  specks: Specks;
  /** Pixels inside an ignore area: not measured, so neither changed nor unchanged. */
  ignoredPixels: number;
  /** The ignore areas the diff skipped, clipped to the overlap. */
  ignored: IgnoreRect[];
  createdAt: string;
  label?: string;
  /** The diff options the run was compared with; absent when none were set. */
  diff?: DiffOptions;
};

export const RUN_FILES = ["main.png", "branch.png", "diff.png"] as const;

export type FrameSize = { width: number; height: number };

export type WrittenRun = {
  manifest: RunManifest;
  main: FrameSize;
  branch: FrameSize;
};

export function newRunId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function isSafeRunId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 80;
}

export async function writeRunFiles(
  dest: string,
  input: {
    main: Buffer;
    branch: Buffer;
    label?: string | undefined;
    diff?: DiffOptions | undefined;
    ignore?: DiffIgnore | undefined;
    id?: string;
    createdAt?: string;
  },
): Promise<WrittenRun> {
  const diff = diffPngs(input.main, input.branch, input.diff, input.ignore);
  const manifest: RunManifest = {
    id: input.id && isSafeRunId(input.id) ? input.id : newRunId(),
    changedPixels: diff.changedPixels,
    changed: diff.changed,
    regions: diff.regions,
    specks: diff.specks,
    ignoredPixels: diff.ignoredPixels,
    ignored: diff.ignored,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.label) manifest.label = input.label;
  if (input.diff && Object.keys(input.diff).length > 0) manifest.diff = input.diff;
  await mkdir(dest, { recursive: true });
  await Bun.write(join(dest, "main.png"), input.main);
  await Bun.write(join(dest, "branch.png"), input.branch);
  await Bun.write(join(dest, "diff.png"), diff.overlay);
  await Bun.write(join(dest, "manifest.json"), JSON.stringify(manifest));
  return {
    manifest,
    main: { width: diff.mainWidth, height: diff.mainHeight },
    branch: { width: diff.branchWidth, height: diff.branchHeight },
  };
}
