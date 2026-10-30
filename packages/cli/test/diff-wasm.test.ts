import { afterAll, describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, faintPair, tmp } from "./support.ts";

// The engine's Bun loader for `diff.wasm`, counted: the CLI's diff can only run through it.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock(import("../../engine/src/diff-module.bun.ts"), async (original) => {
  const real = await original();
  return {
    diffModule: () => {
      loads.count++;
      return real.diffModule();
    },
  };
});

afterAll(cleanup);

describe("the CLI diffs through diff.wasm (PS-210)", () => {
  test("a --live-png / --local-png run takes the module and measures the change", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const before = loads.count;
    const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {});
    expect(code).toBe(0);
    expect(cap.stdout).toContain("400 changed pixels");
    expect(loads.count).toBeGreaterThan(before);
    expect(await Bun.file(join(dir, "diff.png")).exists()).toBe(true);
  });
});
