import type { DevIteration, DevJudge, JudgeNote } from "./dev-store.ts";
import { saveIteration } from "./dev-store.ts";
import { type SpawnProc, bunSpawn, judgePage, pngNames, resolveJudge } from "./judge.ts";

/**
 * `pixelslash dev --judge` (ob 1740): the design-system judge over an iteration's shots, after its
 * pixel result is out. No local vision model is `skip: no judge`, and nothing is invented.
 */

export type DevJudgeDeps = { spawn?: SpawnProc; which?: (bin: string) => string | null };

async function judgeShots(it: DevIteration, dsDir: string, deps: DevJudgeDeps): Promise<DevJudge> {
  const kind = resolveJudge(deps);
  if (!kind) return { status: "skipped", reason: "no judge", notes: [] };
  const components = await pngNames(dsDir);
  const spawn = deps.spawn ?? bunSpawn;
  const notes: JudgeNote[] = [];
  for (const shot of it.shots) {
    if (!shot.files.shot) continue;
    const hits = await judgePage(shot.files.shot, { dsDir, components, spawn, kind });
    for (const v of hits) notes.push({ name: shot.name, shot: shot.shot, ...v });
  }
  return { status: "done", notes };
}

/** Judge `it` against the rasters in `dsDir`, save the verdict on it, and return it. */
export async function judgeIteration(
  it: DevIteration,
  dsDir: string,
  deps: DevJudgeDeps = {},
): Promise<DevJudge> {
  let judge: DevJudge;
  try {
    judge = await judgeShots(it, dsDir, deps);
  } catch (e) {
    judge = { status: "failed", reason: e instanceof Error ? e.message : String(e), notes: [] };
  }
  it.judge = judge;
  await saveIteration(it);
  return judge;
}
