import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRoutes, type ProcLike, type SpawnProc } from "../src/index.ts";

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

function proc(stdout: string): ProcLike {
  return {
    stdout: stream(stdout),
    stderr: stream(""),
    exited: Promise.resolve(0),
    exitCode: 0,
    signalCode: null,
  };
}

const answerOk: SpawnProc = () => proc("OK");

async function twoRoutes() {
  const dir = await mkdtemp(join(tmpdir(), "ps-routes-"));
  temps.push(dir);
  for (const name of ["index", "pricing"]) {
    await Bun.write(join(dir, "live", `${name}.png`), Bun.file(join(FIXTURES, "button.png")));
    await Bun.write(join(dir, "local", `${name}.png`), Bun.file(join(FIXTURES, "card.png")));
  }
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
    { spawn: answerOk },
  );
}

describe("compareRoutes keeps every route's skip (PS-391)", () => {
  test("no route skipped: no skippedRoutes", async () => {
    const result = await twoRoutes();
    expect(result.skipped).toBe(false);
    expect(result.skippedRoutes).toBeUndefined();
    expect(result.skipReason).toBeUndefined();
  });
});
