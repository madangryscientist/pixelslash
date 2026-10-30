#!/usr/bin/env bun
/**
 * One timing pass in one tree (ob 1790): `bun <tree>/bench/src/perf/probe.ts --fixtures <dir>
 * --stub-port <n> --steps a,b`. The runner starts it once per tree per round and reads the
 * one JSON line it prints (a `ProbeResult`). It imports the engine and the web app of the tree it
 * sits in, so the runner copies this folder into the base worktree before running it there.
 */
import { stopLive, timeServerBuild } from "./step-build.ts";
import { timeCapture } from "./step-capture.ts";
import { timeDiff } from "./step-diff.ts";
import { isStep, type ProbeResult } from "./steps.ts";
import { say, warn } from "../say.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function option(name: string): string {
  const at = process.argv.indexOf(name);
  const value = process.argv[at + 1];
  if (at < 0 || value === undefined) throw new Error(`probe: ${name} is required`);
  return value;
}

const fixtures = option("--fixtures");
const stubPort = Number(option("--stub-port"));
const steps = option("--steps").split(",").filter(isStep);
const tree = join(dirname(fileURLToPath(import.meta.url)), "../../..");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopLive().finally(() => process.exit(130));
  });
}

const result: ProbeResult = {};
for (const step of steps) {
  warn(`  probe: ${step}`);
  if (step === "capture") result[step] = await timeCapture();
  else if (step === "server-build") result[step] = await timeServerBuild(fixtures, tree, stubPort);
  else result[step] = timeDiff(fixtures, step);
}
say(JSON.stringify(result));
