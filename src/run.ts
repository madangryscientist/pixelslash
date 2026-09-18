import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diffPngs } from "./diff.ts";

export type RunManifest = {
  id: string;
  changedPixels: number;
  createdAt: string;
  label?: string;
};

export const RUN_FILES = ["main.png", "branch.png", "diff.png"] as const;

export function newRunId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function isSafeRunId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id) && id.length > 0 && id.length <= 80;
}

export async function writeRunFiles(
  dest: string,
  input: { main: Buffer; branch: Buffer; label?: string; id?: string; createdAt?: string },
): Promise<RunManifest> {
  const diff = diffPngs(input.main, input.branch);
  const manifest: RunManifest = {
    id: input.id && isSafeRunId(input.id) ? input.id : newRunId(),
    changedPixels: diff.changedPixels,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (input.label) manifest.label = input.label;
  await mkdir(dest, { recursive: true });
  await Bun.write(join(dest, "main.png"), input.main);
  await Bun.write(join(dest, "branch.png"), input.branch);
  await Bun.write(join(dest, "diff.png"), diff.overlay);
  await Bun.write(join(dest, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}
