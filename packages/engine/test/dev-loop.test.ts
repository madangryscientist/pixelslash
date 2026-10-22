import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { claimSession, liveSession } from "../src/dev-lock.ts";
import { DEV_HEADER, type DevState, serveDevPage } from "../src/dev-page.ts";
import { devController } from "../src/dev-session.ts";
import { debounce, notIgnored, watchTree } from "../src/dev-watch.ts";
import { UsageError } from "../src/errors.ts";
import { cleanupDev, fakeSession, tmpDir, tmpStore } from "./dev-fixtures.ts";

afterAll(cleanupDev);

/** `pixelslash dev`'s loop (ob 1740): debounce, the watcher, the lock, the probe, the live page. */

async function until<T>(get: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

const noop = () => {};
const silent = { onRun: () => {}, onJudge: () => {}, onError: () => {} };

describe("dev trigger", () => {
  test("a burst of saves is one run with every path; a save during a run is one more", async () => {
    const runs: string[][] = [];
    let release = noop;
    const bounce = debounce(30, async (paths) => {
      runs.push(paths);
      if (runs.length === 1) await new Promise<void>((r) => (release = r));
    });
    for (const p of ["a", "b", "a", "c"]) bounce.touch(p);
    await until(async () => (runs.length === 1 ? true : undefined));
    expect(runs[0]?.toSorted()).toEqual(["a", "b", "c"]);
    bounce.touch("d");
    bounce.touch("e");
    await Bun.sleep(80);
    expect(runs).toHaveLength(1);
    release();
    await until(async () => (runs.length === 2 ? true : undefined));
    expect(runs[1]).toEqual(["d", "e"]);
    await Bun.sleep(80);
    expect(runs).toHaveLength(2);
    bounce.close();
  });

  test("the working tree is watched; git's ignores and our own output are not a change", async () => {
    const root = await tmpDir();
    await git(root, "init", "-q");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "page.html"), "<p>one</p>");
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const seen: string[] = [];
    const stop = await watchTree({ root }, (p) => seen.push(p));
    try {
      await mkdir(join(root, ".pixelslash"));
      await writeFile(join(root, ".pixelslash", "x"), "ours");
      await writeFile(join(root, "src", "page.html"), "<p>two</p>");
      await until(async () => (seen.some((p) => p.endsWith("page.html")) ? true : undefined));
      expect(seen.some((p) => p.includes(".pixelslash"))).toBe(false);
    } finally {
      stop();
    }
    expect(await notIgnored(root, ["src/page.html", "dist/out.js", ".pixelslash/x"])).toEqual([
      "src/page.html",
    ]);
  });

  test("a --watch path that does not exist is a usage error", async () => {
    const root = await tmpDir();
    await expect(watchTree({ root, paths: ["nope"] }, () => {})).rejects.toThrow(UsageError);
  });
});

describe("dev session", () => {
  test("a second claim names the live owner; a dead owner's lock is taken over", async () => {
    const store = await tmpStore();
    const page = Bun.serve({ port: 0, fetch: () => Response.json({}) });
    const url = `http://127.0.0.1:${page.port}`;
    const first = await claimSession(store, { pid: 101, url, target: "index" });
    expect(first.held).toBe(true);
    const alive = { pidAlive: () => true };
    const second = await claimSession(store, { pid: 202, url: null, target: "x" }, alive);
    expect(second).toEqual({ held: false, owner: { pid: 101, url, target: "index" } });
    expect(await liveSession(store, alive)).toMatchObject({ pid: 101 });
    const dead = { pidAlive: (pid: number) => pid !== 101 };
    expect(await liveSession(store, dead)).toBeUndefined();
    const third = await claimSession(store, { pid: 303, url: null, target: "index" }, dead);
    expect(third.held).toBe(true);
    await page.stop(true);
  });

  test("a save shows its pixel result on the live page within 2 s of the page settling", async () => {
    const root = await tmpDir();
    const store = await tmpStore();
    const settle = 300;
    const { session, page } = fakeSession(settle);
    const ctl = devController({
      ...silent,
      store,
      session,
      target: "index",
      maxBytes: 1e9,
      main: undefined,
      noMain: "",
      againstMain: false,
      judge: undefined,
    });
    const live = serveDevPage(store, "index", ctl);
    const bounce = debounce(50, async () => void (await ctl.run()));
    const stop = await watchTree({ root, paths: ["."] }, bounce.touch);
    const state = async (): Promise<DevState> => {
      const res = await fetch(`${live.url}/api/state`);
      return JSON.parse(await res.text());
    };
    try {
      await ctl.run();
      const before = (await state()).latest?.id;
      page.at = 4;
      const saved = performance.now();
      await writeFile(join(root, "page.html"), "<p>edited</p>");
      const after = await until(async () => {
        const s = await state();
        return s.latest && s.latest.id !== before ? s.latest : undefined;
      });
      const shown = performance.now() - saved;
      expect(after.counts.changed).toBe(1);
      expect(after.timings.settleMs).toBe(settle);
      expect(after.timings.oursMs).toBeLessThan(after.timings.totalMs);
      expect(shown - after.timings.settleMs).toBeLessThan(2000);
      const forbidden = await fetch(`${live.url}/api/run`, { method: "POST" });
      expect(forbidden.status).toBe(403);
      const pinned = await fetch(`${live.url}/api/pin`, {
        method: "POST",
        headers: { [DEV_HEADER]: "1" },
      });
      expect(await pinned.json()).toEqual({ pinned: after.id });
      expect((await fetch(`${live.url}/files/..%2F..%2Fx`)).status).toBe(404);
      expect((await fetch(`${live.url}/files/%E0`)).status).toBe(404);
    } finally {
      stop();
      bounce.close();
      await ctl.idle();
      await live.stop();
    }
  });

  test("--against main without credentials stays on the previous iteration and says why", async () => {
    const store = await tmpStore();
    const { session } = fakeSession(0);
    const ctl = devController({
      ...silent,
      store,
      session,
      target: "index",
      maxBytes: 1e9,
      main: undefined,
      noMain: "no credentials",
      againstMain: true,
      judge: undefined,
    });
    expect(ctl.mode()).toMatchObject({ against: "previous", note: "no credentials" });
    await ctl.run();
    const it = await ctl.run();
    expect(it?.against.kind).toBe("previous");
    expect(it?.note).toBe("no credentials");
  });
});
