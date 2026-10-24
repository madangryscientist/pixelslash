/** The real `EnvDeps` of `--env` (ob 1947): sudo, systemctl, /proc and the sampler process. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatCpus } from "../../env/cpulist.ts";
import { SCOPE } from "../../env/reserve.ts";
import { HELPER_PATH, type EnvDeps } from "./env.ts";
import type { SamplerResult } from "./proc.ts";
import { run } from "./worktree.ts";

/** The helper is not one of the runner's `running` children: a signal must not cut `on` or `off` short. */
async function helperRun(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["sudo", "-n", HELPER_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const SAMPLER = join(fileURLToPath(new URL(".", import.meta.url)), "sampler.ts");

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function startSampler(cpus: number[]): { stop(): Promise<SamplerResult | null> } {
  const proc = Bun.spawn(
    ["bun", SAMPLER, "--cpus", formatCpus(cpus), "--scope", SCOPE, "--pid", String(process.pid)],
    {
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  return {
    async stop() {
      proc.kill("SIGTERM");
      const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      try {
        const parsed: unknown = JSON.parse(text);
        return isResult(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
  };
}

function isResult(x: unknown): x is SamplerResult {
  return typeof x === "object" && x !== null && Reflect.get(x, "samples") !== undefined;
}

/** `exitHooks` is where the runner's cleanups go; the caller runs them, newest first. */
export function realEnvDeps(exitHooks: (() => Promise<void> | void)[]): EnvDeps {
  return {
    read: readOrNull,
    exec: (cmd) => run(cmd, process.cwd()),
    helper: helperRun,
    startSampler,
    pid: process.pid,
    bunVersion: Bun.version,
    onExit: (undo) => void exitHooks.push(undo),
  };
}
