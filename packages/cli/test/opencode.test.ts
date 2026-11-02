import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { OPENCODE_MODEL_ENV, type SpawnProc } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { DS, capture, cleanup, fakeProc, tmp } from "./support.ts";

afterAll(cleanup);

const MODEL = "opencode-go/some-vision-model";
const mlxOnly = (bin: string) => (bin === "mlx_vlm.generate" ? "/bin/mlx" : null);

async function judged(spawn: SpawnProc, env: NodeJS.ProcessEnv) {
  const out = join(await tmp(), "out");
  const cap = capture();
  const args = ["--live-png", join(DS, "button.png"), "--local-png", join(DS, "card.png")];
  const code = await run([...args, "--ds", DS, "--out", out], cap.io, {
    spawn,
    which: mlxOnly,
    env,
  });
  const report = await Bun.file(join(out, "report.html")).text();
  return { code, stdout: cap.stdout, report };
}

describe("PIXELSLASH_OPENCODE_MODEL", () => {
  test("judges with opencode, not the local engine, and exits like any judge", async () => {
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc(cmd.at(-1)!.includes('"button"') ? "VIOLATION fill is red" : "OK");
    };
    const { code, stdout } = await judged(spawn, { [OPENCODE_MODEL_ENV]: MODEL });
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c[0] === "opencode")).toBe(true);
    expect(cmds[0]).not.toContain("--auto");
    // The same pair on Main and Branch is not a new violation: exit 0, as with a local judge.
    expect(code).toBe(0);
    expect(stdout).toContain("already on main");
  });

  test("nothing configured: the local engine judges and opencode is never run", async () => {
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc("OK");
    };
    const { code } = await judged(spawn, {});
    expect(code).toBe(0);
    expect(cmds.every((c) => c[0] === "mlx_vlm.generate")).toBe(true);
  });

  const failures: Record<string, () => ReturnType<SpawnProc>> = {
    "binary missing": () => {
      throw Object.assign(new Error("Executable not found in $PATH"), { code: "ENOENT" });
    },
    timeout: () => fakeProc("", "", null),
    exit: () => fakeProc("", "ProviderError", 1),
    "empty answer": () => fakeProc("\n"),
  };
  for (const [reason, spawn] of Object.entries(failures)) {
    test(`${reason}: the judge is skipped by name, nothing is invented, exit 0`, async () => {
      const { code, stdout, report } = await judged(spawn, { [OPENCODE_MODEL_ENV]: MODEL });
      expect(code).toBe(0);
      expect(stdout).toContain(`skip: judge ${reason}`);
      expect(stdout).not.toContain("new on branch");
      expect(report).toContain(`skip: judge ${reason}`);
      expect(report).not.toContain("No violations");
    });
  }
});
