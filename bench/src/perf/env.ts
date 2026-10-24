/**
 * `bench:perf --env dedicated` (ob 1947): the lifecycle around a timing run, and the header that says
 * what machine state the numbers were taken in. `--env none` (the default) measures the shared
 * desktop as it is and still records the header, so a result always says which it was.
 *
 * Dedicated: the runner asks the root helper (bench/env/reserve.ts, installed by bench/env/install.sh)
 * to reserve whole cores and memory and to move the runner itself into a scope on them, so every
 * child it starts runs there and no per-child wrapper skews the timings. The helper undoes it all on
 * `off`, which the runner always calls on the way out.
 */
import { formatCpus, parseCpus } from "../../env/cpulist.ts";
import { DEFAULT_CPUS, DEFAULT_MEM, HELPER_VERSION, SCOPE } from "../../env/reserve.ts";
import type { SamplerResult } from "./proc.ts";

export const HELPER_PATH = "/usr/local/sbin/pixelslash-bench-reserve";
export const INSTALL_COMMAND = "bench/env/install.sh";

export type EnvName = "none" | "dedicated";
export type EnvChoice = { name: EnvName; cpus: string; mem: string };
export const defaultEnv = (): EnvChoice => ({ name: "none", cpus: DEFAULT_CPUS, mem: DEFAULT_MEM });

export type EnvHeader = {
  env: EnvName;
  cpuModel: string;
  kernel: string;
  bun: string;
  dotnet: string;
  /** The reserved CPUs, as the scope reports them; null for `none`. */
  reservedCpus: string | null;
  /** What the host's own slices were left with during the run (user.slice AllowedCPUs). */
  hostCpus: string | null;
  memoryMin: string | null;
  memoryMax: string | null;
  boost: string;
  governor: string;
  /** Measured on the reserved cores during the run; null for `none` (no cores to watch). */
  freqMhz: SamplerResult["freqMhz"];
  loadStart: string;
  loadEnd: string;
  /** Other tasks seen running on the reserved CPUs; null for `none`. */
  foreign: SamplerResult["foreign"] | null;
};

type Out = { code: number; out: string; err: string };

/** What the run touches on the machine; a test supplies fakes. */
export type EnvDeps = {
  read(path: string): string | null;
  exec(cmd: string[]): Promise<Out>;
  /** `sudo -n <helper> <args>`. */
  helper(args: string[]): Promise<Out>;
  /** Start the /proc sampler (outside the scope) for these CPUs. */
  startSampler(cpus: number[]): { stop(): Promise<SamplerResult | null> };
  pid: number;
  bunVersion: string;
  /** Run on the way out, newest first, also on a signal. */
  onExit(undo: () => Promise<void>): void;
};

/** A request the run cannot start with; the message says what to do, and it is exit 2. */
export class EnvUsageError extends Error {}

const SYS_CPU = "/sys/devices/system/cpu";

const firstLine = (text: string | null): string => (text ?? "").split("\n")[0]?.trim() ?? "";

async function versionOf(deps: EnvDeps, cmd: string[]): Promise<string> {
  try {
    const r = await deps.exec(cmd);
    return r.code === 0 ? firstLine(r.out) : "unavailable";
  } catch {
    return "unavailable";
  }
}

const loadNow = (deps: EnvDeps): string => (deps.read("/proc/loadavg") ?? "").split(" ")[0] ?? "";

/** The distinct governors of the given CPUs, e.g. "performance". */
function governors(deps: EnvDeps, cpus: number[]): string {
  const seen = new Set(
    cpus.map((c) => firstLine(deps.read(`${SYS_CPU}/cpu${c}/cpufreq/scaling_governor`)) || "n/a"),
  );
  return [...seen].join("+");
}

async function baseHeader(deps: EnvDeps, env: EnvName): Promise<EnvHeader> {
  const model = /^model name\s*:\s*(.+)$/m.exec(deps.read("/proc/cpuinfo") ?? "")?.[1];
  const online = parseCpus(firstLine(deps.read(`${SYS_CPU}/online`)) || "0");
  return {
    env,
    cpuModel: model ?? "unknown",
    kernel: firstLine(deps.read("/proc/sys/kernel/osrelease")) || "unknown",
    bun: deps.bunVersion,
    dotnet: await versionOf(deps, ["dotnet", "--version"]),
    reservedCpus: null,
    hostCpus: null,
    memoryMin: null,
    memoryMax: null,
    boost: firstLine(deps.read(`${SYS_CPU}/cpufreq/boost`)) || "n/a",
    governor: governors(deps, online),
    freqMhz: null,
    loadStart: loadNow(deps),
    loadEnd: "",
    foreign: null,
  };
}

async function property(deps: EnvDeps, unit: string, name: string): Promise<string | null> {
  const r = await deps.exec(["systemctl", "show", "-p", name, "--value", unit]);
  return r.code === 0 ? r.out.trim() : null;
}

function parseStatus(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The helper is installed, current, and not left reserved by a run that died. */
async function preflight(deps: EnvDeps): Promise<void> {
  const r = await deps.helper(["status"]);
  if (r.code !== 0)
    throw new EnvUsageError(
      `--env dedicated needs the root helper, and \`sudo -n ${HELPER_PATH} status\` failed (${r.err.trim() || `exit ${r.code}`}).\n` +
        `Install it once, from this repo: ${INSTALL_COMMAND}  (it prints what it will change and asks first).`,
    );
  const status = parseStatus(r.out);
  if (
    typeof status !== "object" ||
    status === null ||
    Reflect.get(status, "version") !== HELPER_VERSION
  )
    throw new EnvUsageError(`the installed helper is out of date: run ${INSTALL_COMMAND} again.`);
  if (Reflect.get(status, "active") === true)
    throw new EnvUsageError(
      `a previous run left the machine reserved: run \`sudo -n ${HELPER_PATH} off\` to restore it.`,
    );
}

export type EnvSession = {
  /** Stop watching, restore the machine, and return the header with what was measured. */
  finish(): Promise<EnvHeader>;
};

/** Start the chosen environment. For dedicated, the runner is inside the scope when this returns. */
export async function beginEnv(choice: EnvChoice, deps: EnvDeps): Promise<EnvSession> {
  const header = await baseHeader(deps, choice.name);
  if (choice.name === "none")
    return {
      finish: async () => ({ ...header, loadEnd: loadNow(deps) }),
    };
  await preflight(deps);
  const cpus = parseCpus(choice.cpus);
  let sampler: ReturnType<EnvDeps["startSampler"]> | null = null;
  let result: SamplerResult | null = null;
  let restored: Promise<void> | null = null;
  // `off` never overlaps an `on` still running (a signal can arrive in between): it waits for it to end.
  let onEnded: Promise<unknown> = Promise.resolve();
  const restore = (): Promise<void> => {
    restored ??= (async () => {
      await onEnded;
      // `off` runs even when stopping the sampler throws: it is what puts the machine back.
      const watching = sampler;
      sampler = null;
      const stopped = await Promise.resolve(watching?.stop()).then(
        (r) => ({ r: r ?? result, err: null }),
        (err: unknown) => ({ r: result, err }),
      );
      result = stopped.r;
      const off = await deps.helper(["off"]);
      if (off.code !== 0) throw new Error(`restoring the machine failed: ${off.err.trim()}`);
      if (stopped.err !== null) throw stopped.err;
    })().catch((e: unknown) => {
      restored = null; // a failed `off` may be tried again by the next caller
      throw e;
    });
    return restored;
  };
  // Registered before `on`: off is a no-op when nothing was recorded, and is the only way out if `on` is cut short.
  deps.onExit(restore);
  // Started now, outside the scope (a child made after `on` would run on the reserved cores); it takes
  // no sample until the runner is inside the scope.
  sampler = deps.startSampler(cpus);
  const starting = deps.helper([
    "on",
    "--cpus",
    formatCpus(cpus),
    "--mem",
    choice.mem,
    "--pid",
    String(deps.pid),
  ]);
  onEnded = starting.catch(() => null);
  const on = await starting;
  if (on.code !== 0) throw new Error(`reserving the cores failed: ${on.err.trim()}`);
  if (!(deps.read("/proc/self/cgroup") ?? "").includes(SCOPE))
    throw new Error(`the runner is not in ${SCOPE} after the helper ran`);
  const during = await duringRun(deps, header, cpus);
  return {
    finish: async () => {
      await restore();
      return {
        ...during,
        loadEnd: loadNow(deps),
        ...(result ? { freqMhz: result.freqMhz, foreign: result.foreign } : {}),
      };
    },
  };
}

/** What the system reports while the reservation holds. */
async function duringRun(deps: EnvDeps, base: EnvHeader, cpus: number[]): Promise<EnvHeader> {
  return {
    ...base,
    reservedCpus: (await property(deps, SCOPE, "AllowedCPUs"))?.replace(/ /g, ",") ?? null,
    hostCpus: (await property(deps, "user.slice", "AllowedCPUs"))?.replace(/ /g, ",") ?? null,
    memoryMin: await property(deps, SCOPE, "MemoryMin"),
    memoryMax: await property(deps, SCOPE, "MemoryMax"),
    boost: firstLine(deps.read(`${SYS_CPU}/cpufreq/boost`)) || "n/a",
    governor: governors(deps, cpus),
  };
}

const BOOST_LABEL: Record<string, string> = { "1": "on", "0": "off" };

const mhz = (n: number): string => `${Math.round(n)}`;

function reservedLines(h: EnvHeader): string[] {
  const lines = [
    `reserved CPUs ${h.reservedCpus ?? "?"} (host kept ${h.hostCpus ?? "?"}) · memory min ${h.memoryMin ?? "?"} max ${h.memoryMax ?? "?"}`,
  ];
  lines.push(
    h.freqMhz
      ? `reserved cores ran at ${mhz(h.freqMhz.mean)} MHz (min ${mhz(h.freqMhz.min)}, max ${mhz(h.freqMhz.max)})`
      : "reserved cores' frequency: not measured (the sampler returned nothing)",
  );
  if (!h.foreign)
    lines.push("other tasks on the reserved CPUs: not measured (the sampler returned nothing)");
  else {
    const { tasks, kernel } = h.foreign;
    lines.push(
      `other tasks seen on the reserved CPUs: ${tasks.length}${tasks.length > 0 ? ` (${tasks.join(", ")})` : ""}${kernel.length > 0 ? `; kernel threads: ${kernel.join(", ")}` : ""}`,
    );
  }
  return lines;
}

/** The header as printed under the table's title. */
export function headerLines(h: EnvHeader): string[] {
  return [
    `env: ${h.env} · ${h.cpuModel} · kernel ${h.kernel} · bun ${h.bun} · dotnet ${h.dotnet}`,
    `boost ${BOOST_LABEL[h.boost] ?? h.boost} · governor ${h.governor} · host load ${h.loadStart} at start, ${h.loadEnd} at end`,
    ...(h.env === "none" ? [] : reservedLines(h)),
  ];
}
