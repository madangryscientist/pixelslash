import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { compareRoutes, OPENCODE_MODEL_ENV, type ProcLike, type SpawnProc } from "../src/index.ts";

const FIXTURES = new URL("../../../fixtures/ds/", import.meta.url).pathname;
const temps: string[] = [];
afterAll(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      if (text) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

function proc(stdout: string, exitCode: number | null = 0): ProcLike {
  return {
    stdout: stream(stdout),
    stderr: stream(""),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode: null,
  };
}

async function twoRoutes(failing: string[], env: NodeJS.ProcessEnv) {
  const dir = await mkdtemp(join(tmpdir(), "ps-routes-"));
  temps.push(dir);
  for (const name of ["index", "pricing"]) {
    await Bun.write(join(dir, "live", `${name}.png`), Bun.file(join(FIXTURES, "button.png")));
    await Bun.write(join(dir, "local", `${name}.png`), Bun.file(join(FIXTURES, "card.png")));
  }
  const spawn: SpawnProc = (_cmd, opts) =>
    failing.includes(basename(opts?.cwd ?? "")) ? proc("", 1) : proc("OK");
  return compareRoutes(
    {
      live: undefined,
      local: undefined,
      livePng: undefined,
      localPng: undefined,
      livePngDir: join(dir, "live"),
      localPngDir: join(dir, "local"),
      routes: ["/", "/pricing"],
      ds: FIXTURES,
      out: join(dir, "out"),
      width: 1280,
      label: undefined,
      diff: {},
      ignore: [],
    },
    { spawn, env },
  );
}

describe("compareRoutes keeps every route's skip (PS-391)", () => {
  const env = { [OPENCODE_MODEL_ENV]: "opencode-go/some-vision-model" };

  test("one route skipped: it is named, and the run is not skipped", async () => {
    const result = await twoRoutes(["index"], env);
    expect(result.skipped).toBe(false);
    expect(result.skippedRoutes).toEqual([{ route: "/", reason: "judge exit" }]);
    expect(result.skipReason).toBe("judge exit");
  });

  test("the last route skipped: the first route is still judged", async () => {
    const result = await twoRoutes(["pricing"], env);
    expect(result.skipped).toBe(false);
    expect(result.skippedRoutes).toEqual([{ route: "/pricing", reason: "judge exit" }]);
  });

  test("every route skipped: skipped, with the first route's reason", async () => {
    const result = await twoRoutes(["index", "pricing"], env);
    expect(result.skipped).toBe(true);
    expect(result.skippedRoutes?.map((s) => s.route)).toEqual(["/", "/pricing"]);
    expect(result.skipReason).toBe("judge exit");
  });

  test("no route skipped: no skippedRoutes", async () => {
    const result = await twoRoutes([], env);
    expect(result.skipped).toBe(false);
    expect(result.skippedRoutes).toBeUndefined();
    expect(result.skipReason).toBeUndefined();
  });
});
