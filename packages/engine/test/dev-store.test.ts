import { afterAll, describe, expect, test } from "vitest";
import { runIteration } from "../src/dev-run.ts";
import {
  devStore,
  latestIteration,
  listIterations,
  pinIteration,
  pruneIterations,
  readPins,
  unpinIteration,
} from "../src/dev-store.ts";
import { cleanupDev, fakeSession, tmpStore } from "./dev-fixtures.ts";

afterAll(cleanupDev);

/** `pixelslash dev`'s iterations (ob 1740): the previous-iteration diff, pins, a restart, pruning. */

const MAX = 200 * 1024 * 1024;

describe("dev iterations", () => {
  test("each run is diffed with the previous one, with our time apart from the settle", async () => {
    const store = await tmpStore();
    const { session, page } = fakeSession(40);
    const opts = { store, session, target: "index", maxBytes: MAX };
    const first = await runIteration(opts);
    expect(first.against).toEqual({ kind: "none", iteration: null });
    expect(first.counts.new).toBe(1);
    const same = await runIteration(opts);
    expect(same.against).toEqual({ kind: "previous", iteration: first.id });
    expect(same.counts).toMatchObject({ changed: 0, unchanged: 1 });
    page.at = 4;
    const edited = await runIteration(opts);
    expect(edited.against).toEqual({ kind: "previous", iteration: same.id });
    expect(edited.counts.changed).toBe(1);
    expect(edited.changedPixels).toBe(24);
    expect(edited.regions).toBe(1);
    expect(edited.shots[0]?.files.diff).toBeDefined();
    expect(edited.timings.settleMs).toBe(40);
    expect(edited.timings.oursMs).toBeCloseTo(edited.timings.totalMs - 40, 5);
  });

  test("a pin is the comparison point until unpinned, and both survive a restart", async () => {
    const store = await tmpStore();
    const { session, page } = fakeSession(0);
    const opts = { store, session, target: "index", maxBytes: MAX };
    const base = await runIteration(opts);
    expect(await pinIteration(store)).toBe(base.id);
    page.at = 4;
    await runIteration(opts);
    page.at = 8;
    const later = await runIteration(opts);
    expect(later.against).toEqual({ kind: "pin", iteration: base.id });

    // A restart is a new store on the same worktree: the files are the truth.
    const again = devStore(store.root.replace(/\/\.pixelslash\/dev$/, ""));
    expect(await readPins(again)).toEqual([base.id]);
    expect((await latestIteration(again, "index"))?.id).toBe(later.id);
    expect(await unpinIteration(again)).toBe(base.id);
    expect(await readPins(again)).toEqual([]);
    const after = await runIteration({ ...opts, store: again });
    expect(after.against).toEqual({ kind: "previous", iteration: later.id });
  });

  test("pruning past the cap removes the oldest first, never a pin or the newest's comparison", async () => {
    const store = await tmpStore();
    const { session, page } = fakeSession(0);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      page.at = i;
      ids.push((await runIteration({ store, session, target: "index", maxBytes: MAX })).id);
    }
    await pinIteration(store, ids[0]);
    const removed = await pruneIterations(store, 1);
    expect(removed).toEqual([ids[1]]);
    expect(await listIterations(store)).toEqual([ids[0], ids[2], ids[3]]);
  });

  test("the cap is applied after every run", async () => {
    const store = await tmpStore();
    const { session, page } = fakeSession(0);
    const pinned = (await runIteration({ store, session, target: "index", maxBytes: MAX })).id;
    await pinIteration(store, pinned);
    for (let i = 1; i < 4; i++) {
      page.at = i;
      await runIteration({ store, session, target: "index", maxBytes: 1 });
    }
    const left = await listIterations(store);
    // The pin, which is also what the newest was compared with, and the newest.
    expect(left).toEqual([pinned, (await latestIteration(store))?.id]);
  });
});
