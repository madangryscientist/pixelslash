#!/usr/bin/env bun
/**
 * `bun bench/src/perf/sampler.ts --cpus <list> --scope <name> --pid <runner> [--interval-ms <n>]`
 * (ob 1947): sample /proc for what runs on the reserved CPUs until SIGTERM, then print one JSON
 * `SamplerResult`. The runner starts it before it enters the scope, so it stays on the host's CPUs,
 * and it takes no sample until the runner's cgroup is the scope.
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseCpus } from "../../env/cpulist.ts";
import { argvReader, positiveInt } from "../impl/flags.ts";
import { Aggregate, scanForeign, type ProcIo } from "./proc.ts";

const USAGE = "usage: sampler.ts --cpus <list> --scope <name> --pid <runner> [--interval-ms <n>]";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function numericEntries(dir: string): number[] {
  try {
    return readdirSync(dir)
      .filter((e) => /^[0-9]+$/.test(e))
      .map(Number);
  } catch {
    return [];
  }
}

const io: ProcIo = {
  pids: () => numericEntries("/proc"),
  tids: (pid) => numericEntries(`/proc/${pid}/task`),
  read: readOrNull,
};

function options(): { cpus: number[]; scope: string; runner: number; intervalMs: number } {
  const reader = argvReader(process.argv.slice(2), USAGE);
  let cpus: number[] = [];
  let scope = "";
  let runner = 0;
  let intervalMs = 250;
  for (let a = reader.next(); a !== undefined; a = reader.next()) {
    if (a === "--cpus") cpus = parseCpus(reader.value(a));
    else if (a === "--scope") scope = reader.value(a);
    else if (a === "--pid") runner = positiveInt(a, reader.value(a));
    else if (a === "--interval-ms") intervalMs = positiveInt(a, reader.value(a));
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (cpus.length === 0 || scope === "" || runner === 0) throw new Error(USAGE);
  return { cpus, scope, runner, intervalMs };
}

const { cpus, scope, runner, intervalMs } = options();
const aggregate = new Aggregate();

function sample(): void {
  const cgroup = readOrNull(`/proc/${runner}/cgroup`);
  // A runner that was killed cannot send the SIGTERM: do not outlive it.
  if (cgroup === null) process.exit(0);
  // Before the reservation (or after the runner left the scope) the machine is the shared desktop.
  if (!cgroup.includes(scope)) return;
  const khz = cpus.map((c) =>
    Number(readOrNull(`/sys/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`)),
  );
  aggregate.add(
    scanForeign(io, cpus, scope, process.pid),
    khz.filter((k) => Number.isFinite(k) && k > 0),
  );
}

const timer = setInterval(sample, intervalMs);
process.on("SIGTERM", () => {
  clearInterval(timer);
  process.stdout.write(`${JSON.stringify(aggregate.result())}\n`);
  process.exit(0);
});
sample();
