import { chmodSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { devState } from "../src/dev-page.ts";
import { runIteration } from "../src/dev-run.ts";
import {
  comparisonPoint,
  devStore,
  iterationDir,
  latestIteration,
  listIterations,
  pinIteration,
  pruneIterations,
  readIteration,
  readPins,
  unpinIteration,
  withPinsLock,
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

describe("a failed iteration (PS-395)", () => {
  test("a run that throws is stored as failed and is never the comparison point", async () => {
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const opts = { store, session, target: "index", maxBytes: MAX };
    const good = await runIteration(opts);
    const shoot = session.shoot;
    session.shoot = async () => {
      throw new Error("page crashed");
    };
    await expect(runIteration(opts)).rejects.toThrow("page crashed");
    session.shoot = shoot;

    const ids = await listIterations(store);
    expect(ids).toHaveLength(2);
    const failed = await readIteration(store, ids[1] ?? "");
    expect(failed).toMatchObject({
      error: "page crashed",
      shots: [],
      report: "",
      judge: null,
      against: { kind: "none", iteration: null },
      counts: { changed: 0, unchanged: 0, new: 0, removed: 0 },
    });
    expect((await latestIteration(store, "index"))?.id).toBe(good.id);
    expect(await comparisonPoint(store, "index")).toEqual({ kind: "previous", iteration: good.id });
    expect(await pinIteration(store, failed?.id)).toBeUndefined();
    expect(await pinIteration(store)).toBe(good.id);
    expect((await runIteration(opts)).against).toEqual({ kind: "pin", iteration: good.id });
  });

  test("the page state lists the failed step first and keeps the finished run as latest", async () => {
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const opts = { store, session, target: "index", maxBytes: MAX };
    const good = await runIteration(opts);
    session.shoot = async () => {
      throw new Error("page crashed");
    };
    await expect(runIteration(opts)).rejects.toThrow("page crashed");
    const state = await devState(store, "index", {
      against: "previous",
      note: null,
      running: false,
    });
    expect(state.latest?.id).toBe(good.id);
    expect(state.timeline.map((t) => t.id)).toEqual([(await listIterations(store))[1], good.id]);
    expect(state.timeline[0]?.error).toBe("page crashed");
    expect(state.timeline[1]?.error).toBeUndefined();
  });

  test("a failed record that cannot be saved leaves the run's own error to be reported", async () => {
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const opts = { store, session, target: "index", maxBytes: MAX };
    let runDir = "";
    session.shoot = async () => {
      // A store that cannot take the failed record (a read-only dir, a full disk): the caller still
      // hears about the page, not about the store.
      runDir = iterationDir(store, (await listIterations(store)).at(-1) ?? "");
      chmodSync(runDir, 0o555);
      throw new Error("page crashed");
    };
    try {
      await expect(runIteration(opts)).rejects.toThrow("page crashed");
    } finally {
      chmodSync(runDir, 0o755);
    }
  });

  test("a prune that throws does not overwrite the result the run just saved", async () => {
    const store = await tmpStore();
    const { session, page } = fakeSession(0);
    const opts = { store, session, target: "index", maxBytes: 1 };
    await runIteration(opts);
    page.at = 1;
    await runIteration(opts);
    const iterations = join(store.root, "iterations");
    const shoot = session.shoot;
    session.shoot = async (route, variant, scan) => {
      // Nothing old can be removed from a read-only iterations dir, so only the prune fails; this
      // run's own dir stays writable, so its result still saves.
      chmodSync(iterations, 0o555);
      return shoot(route, variant, scan);
    };
    try {
      page.at = 2;
      const third = await runIteration(opts);
      const saved = await readIteration(store, third.id);
      expect(saved?.error).toBeUndefined();
      expect(saved?.counts.changed).toBe(1);
      expect(saved?.shots).toHaveLength(1);
    } finally {
      chmodSync(iterations, 0o755);
    }
  });
});

/** A store with three finished runs, as `[store, a, b, c]` ids. */
async function three() {
  const store = await tmpStore();
  const { session, page } = fakeSession(0);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    page.at = i;
    ids.push((await runIteration({ store, session, target: "index", maxBytes: MAX })).id);
  }
  return { store, ids: { 0: ids[0] ?? "", 1: ids[1] ?? "", 2: ids[2] ?? "" } };
}

describe("pins under a lock (PS-395)", () => {
  test("two concurrent pins both end up pinned", async () => {
    const { store, ids } = await three();
    await Promise.all([pinIteration(store, ids[0]), pinIteration(store, ids[1])]);
    expect((await readPins(store)).toSorted()).toEqual([ids[0], ids[1]]);
  });

  test("a pin racing an unpin of a third keeps the pin and drops the third", async () => {
    const { store, ids } = await three();
    await pinIteration(store, ids[2]);
    await Promise.all([pinIteration(store, ids[0]), unpinIteration(store, ids[2])]);
    expect(await readPins(store)).toEqual([ids[0]]);
  });

  test("a first pin works on a store whose root does not exist yet", async () => {
    const store = await tmpStore();
    expect(await withPinsLock(store, async () => "ok")).toBe("ok");
  });

  test("a stale lock is taken over, and the lock is gone afterwards", async () => {
    const store = await tmpStore();
    await mkdir(store.root, { recursive: true });
    const lock = join(store.root, "pins.json.lock");
    await Bun.write(lock, "");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withPinsLock(store, async () => "taken", { staleMs: 50 })).toBe("taken");
    expect(await Bun.file(lock).exists()).toBe(false);
  });

  test("a fresh lock held past the wait rejects, and is left alone", async () => {
    const store = await tmpStore();
    await mkdir(store.root, { recursive: true });
    const lock = join(store.root, "pins.json.lock");
    await Bun.write(lock, "");
    await expect(withPinsLock(store, async () => "no", { waitMs: 100 })).rejects.toThrow(
      `pins.json is locked by another pixelslash; remove ${lock} if none is running`,
    );
    expect(await Bun.file(lock).exists()).toBe(true);
  });

  test("the lock is released when the work throws", async () => {
    const store = await tmpStore();
    await expect(
      withPinsLock(store, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withPinsLock(store, async () => "again", { waitMs: 100 })).toBe("again");
  });
});
