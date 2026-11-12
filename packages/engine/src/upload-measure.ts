import { baselinePng } from "./baselines-client.ts";
import {
  type BaselinePick,
  type CiResult,
  type PickedShot,
  measureShot,
  withoutSame,
} from "./ci-diff.ts";
import type { ChangeNoter } from "./change-note.ts";
import { identity } from "./manifest.ts";
import type { SnapshotEntry } from "./snapshot.ts";
import { elapsed, type ShotTiming } from "./timings.ts";
import type { Client } from "./upload-client.ts";
import { sha256Of } from "./upload-form.ts";

/** One shot's measure in an upload: against its baselines, by bytes or by diff, and the judge's note on a change. */

/**
 * Whether `png` is byte for byte every shot the server named for it (PS-445): by the hash it sent,
 * else by the baseline's bytes, fetched once into `mains`. False when it named none.
 */
export async function sameAsBaselines(
  client: Client,
  pick: BaselinePick | undefined,
  png: Buffer,
  mains: Map<string, Buffer>,
): Promise<boolean> {
  const named = [pick?.baseline, pick?.accepted].filter((p): p is PickedShot => p != null);
  if (named.length === 0) return false;
  const hash = sha256Of(png);
  for (const p of named) {
    // A hash the server sent settles it either way; only a shot without one is fetched.
    if (typeof p.sha256 === "string") {
      if (p.sha256 !== hash) return false;
      continue;
    }
    const main = mains.get(p.id) ?? (await baselinePng(client, p));
    mains.set(p.id, main);
    if (!main.equals(png)) return false;
  }
  return true;
}

/**
 * One PNG of a shot measured against its pick. A baseline with this PNG's own bytes is unchanged:
 * it is not fetched or diffed. A CI project sends a result and its mask for every baseline, so it
 * measures them all. `counted` says the shot was measured, changed or not.
 */
export async function measurePng(
  client: Client,
  shot: {
    e: SnapshotEntry;
    png: Buffer;
    pick: BaselinePick | undefined;
    ci: boolean;
    measuring: boolean;
    mains: Map<string, Buffer>;
  },
  timing: ShotTiming,
) {
  const { e, png, pick, ci, measuring, mains } = shot;
  const hash = sha256Of(png);
  const todo = pick && !ci ? withoutSame(pick, hash) : pick;
  const results =
    todo && measuring ? await measureTimed(client, { e, png, pick: todo, mains }, timing) : [];
  const counted = results.length > 0 || (measuring && todo !== pick);
  const changed = results.find((r) => r.status === "changed");
  return { hash, results, changed, counted };
}

/** The judge's sentence for a changed shot; a model that fails is said and the shot goes without. */
export async function changeNote(
  describe: ChangeNoter | undefined,
  shot: {
    e: SnapshotEntry;
    file: string;
    changed: CiResult | undefined;
    mains: Map<string, Buffer>;
  },
  warn: (m: string) => void,
  timing: ShotTiming,
): Promise<string | null> {
  const { e, file, changed, mains } = shot;
  const main = changed && mains.get(changed.baselineId);
  if (!describe || !changed || !main) return null;
  const started = performance.now();
  try {
    return await describe({ file, main, diff: changed.diffResult });
  } catch (err) {
    warn(`judge: ${identity(e)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    timing.judgeMs = elapsed(started);
  }
}

/**
 * `measureShot` with its diff time on `timing`, less the baseline downloads inside it (those are
 * the `fetch baseline` requests). `mains` keeps the baselines for the judge.
 */
async function measureTimed(
  client: Client,
  shot: {
    e: SnapshotEntry;
    png: Buffer;
    pick: BaselinePick;
    mains: Map<string, Buffer>;
  },
  timing: ShotTiming,
): Promise<CiResult[]> {
  const { e, png, pick, mains } = shot;
  let fetching = 0;
  const fetchMain = async (p: PickedShot) => {
    const held = mains.get(p.id);
    if (held) return held;
    const started = performance.now();
    const bytes = await baselinePng(client, p);
    fetching += elapsed(started);
    mains.set(p.id, bytes);
    return bytes;
  };
  const started = performance.now();
  const results = await measureShot(e, png, pick, fetchMain);
  timing.diffMs = Math.max(0, elapsed(started) - fetching);
  return results;
}
