import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, onTestFailed } from "vitest";
import type { KeyInput } from "../src/dev-loop.ts";
import { solidPng } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

/** `pixelslash dev`'s fixtures (ob 1740, 1741), shared by its CLI and MCP tests. */

const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** A git repo with a config whose one route is `page.html` in the repo, read on every request. */
export async function project(width = 400) {
  const cwd = await gitRepo();
  const file = join(cwd, "page.html");
  await writeFile(file, `<body style="margin:0;background:#fff"><p>one</p></body>`);
  const page = Bun.serve({
    port: 0,
    fetch: async () =>
      new Response(await readFile(file, "utf8"), { headers: { "content-type": "text/html" } }),
  });
  servers.push(page);
  await Bun.write(
    join(cwd, "pixelslash.config.json"),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${page.port}`,
      routes: ["/"],
      variants: [{ name: "small", viewport: { width, height: 300 } }],
    }),
  );
  return { cwd, file };
}

export async function until<T>(get: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await get();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

type Shown = { readonly stdout: string; readonly stderr: string };

/**
 * The steps of a long test, each with when it started and ended (ms since the log began), printed
 * with the output of every capture shown to it when the test fails. Vitest's timeout names neither
 * the await that hung nor a line of the test, so the log is what says which step a timeout ate.
 */
export function stepLog() {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const lines: string[] = [];
  const shown: Array<[string, Shown]> = [];
  onTestFailed(() => {
    const out = shown.map(
      ([name, c]) => `--- ${name} stdout:\n${c.stdout}\n--- ${name} stderr:\n${c.stderr}`,
    );
    process.stderr.write(`${["steps (ms since start):", ...lines, ...out].join("\n")}\n`);
  });
  return {
    /** Await `p` as the step `name`: its start, then its end or its throw. */
    step: async <T>(name: string, p: Promise<T>): Promise<T> => {
      lines.push(`  ${at()} start ${name}`);
      try {
        const v = await p;
        lines.push(`  ${at()} done  ${name}`);
        return v;
      } catch (e) {
        lines.push(`  ${at()} threw ${name}: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    /** A step that is one moment, not a wait. */
    mark: (name: string) => {
      lines.push(`  ${at()} ${name}`);
    },
    /** Print this capture's output if the test fails. */
    show: (name: string, c: Shown) => {
      shown.push([name, c]);
    },
  };
}

/**
 * Keys a test presses. Like stdin, keys arrive in order after the call that pressed or listened
 * returns, and a key pressed while nothing listens is held for the next listener. A dev prints
 * its banner before it listens, so a q pressed on the banner of a starved dev used to be dropped
 * here, never by stdin.
 */
export function keyboard(): KeyInput & { press: (k: string) => void } {
  const fns = new Set<(chunk: string) => void>();
  const held: string[] = [];
  const flush = () => {
    while (fns.size > 0) {
      const k = held.shift();
      if (k === undefined) return;
      for (const fn of fns) fn(k);
    }
  };
  return {
    on: (_e, fn) => {
      fns.add(fn);
      queueMicrotask(flush);
    },
    off: (_e, fn) => fns.delete(fn),
    press: (k) => {
      held.push(k);
      queueMicrotask(flush);
    },
  };
}

export const FIGMA = "https://www.figma.com/design/AbC123/Shop?node-id=1-2";

/** `project()` with `features.index`: a spec, a wide repo PNG, and a Figma frame. */
export async function featureProject(width = 400) {
  const p = await project(width);
  await writeFile(join(p.cwd, "cart.md"), "# Cart\nThe total sits under the list.");
  await writeFile(join(p.cwd, "cart.png"), solidPng(2048, 100, [0, 0, 200, 255]));
  const config = JSON.parse(await readFile(join(p.cwd, "pixelslash.config.json"), "utf8"));
  config.features = { index: { spec: "cart.md", refs: ["cart.png", FIGMA] } };
  await writeFile(join(p.cwd, "pixelslash.config.json"), JSON.stringify(config));
  return p;
}
