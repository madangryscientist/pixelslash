import type { Host, Out } from "../env/machine.ts";
import { STATE_FILE } from "../env/journal.ts";
import { runHelper } from "../env/reserve.ts";

export type Fake = Host & {
  files: Map<string, string>;
  calls: string[];
  /** Commands (joined) that fail once, mapped to their stderr. */
  failing: Map<string, string>;
  allowed: Map<string, string>;
  inside: boolean;
  /** The transient timers systemd has loaded, by unit name without `.timer`. */
  timers: Set<string>;
  /** The fake clock, epoch ms. */
  clock: number;
};

export const SELF = "/usr/local/sbin/pixelslash-bench-reserve";
export const START = Date.UTC(2026, 10, 13, 12, 0, 0);

const SIBLINGS = new Map([
  [0, "0,6"],
  [1, "1,7"],
  [2, "2,8"],
  [3, "3,9"],
  [4, "4,10"],
  [5, "5,11"],
  [6, "0,6"],
  [7, "1,7"],
  [8, "2,8"],
  [9, "3,9"],
  [10, "4,10"],
  [11, "5,11"],
]);

export function fake(overrides: { uid?: number | null; pidOwner?: number | null } = {}): Fake {
  const files = new Map<string, string>([
    ["/sys/devices/system/cpu/online", "0-11\n"],
    ["/sys/devices/system/cpu/cpufreq/boost", "1\n"],
    ["/proc/meminfo", "MemTotal:       16000000 kB\n"],
  ]);
  for (const [cpu, sib] of SIBLINGS) {
    files.set(`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`, `${sib}\n`);
    files.set(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`, "powersave\n");
  }
  const allowed = new Map<string, string>();
  const state: Fake = {
    files,
    calls: [],
    failing: new Map(),
    allowed,
    inside: false,
    timers: new Set<string>(),
    clock: START,
    now: () => state.clock,
    selfPath: SELF,
    async exec(cmd): Promise<Out> {
      const line = cmd.join(" ");
      state.calls.push(line);
      return failOnce(state, line) ?? timerCall(state, line) ?? systemctlCall(state, line);
    },
    read: (path) => files.get(path) ?? null,
    write: (path, text) => void files.set(path, text),
    create(path, text) {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    remove: (path) => void files.delete(path),
    mkdir: () => undefined,
    procUid: () => (overrides.pidOwner === undefined ? 1000 : overrides.pidOwner),
    self: 9000,
    callerUid: overrides.uid === undefined ? 1000 : overrides.uid,
    insideScope: () => state.inside,
  };
  return state;
}

export const ON = ["on", "--cpus", "4,5,10,11", "--mem", "4G", "--pid", "4242"];
export const governor = (f: Fake, cpu: number) =>
  f.files.get(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`);

/** Run a request that must be refused; the message, and whether the machine was left alone. */
export async function refusal(
  f: Fake,
  argv: string[],
): Promise<{ message: string; untouched: boolean }> {
  const message = await runHelper(f, argv).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  const untouched = f.calls.every((c) => !c.includes("set-property")) && !f.files.has(STATE_FILE);
  return { message, untouched };
}

/** A command in `failing` fails once, with its stderr. */
function failOnce(state: Fake, line: string): Out | null {
  for (const [needle, err] of state.failing)
    if (line.includes(needle)) {
      state.failing.delete(needle);
      return { code: 1, out: "", err };
    }
  return null;
}

/** Transient timers as systemd would have them: arming loads one, stopping an unloaded one says so. */
function timerCall(state: Fake, line: string): Out | null {
  const arm = /^systemd-run --unit=(\S+) /.exec(line);
  if (arm) {
    const unit = arm[1] ?? "";
    // A name that is still loaded is refused, as systemd does: the code stops the old timer before arming.
    if (state.timers.has(unit))
      return { code: 1, out: "", err: `Unit ${unit}.service already exists.` };
    state.timers.add(unit);
    return null;
  }
  const stop = /^systemctl stop (\S+)\.timer$/.exec(line);
  if (!stop) return null;
  const unit = stop[1] ?? "";
  return state.timers.delete(unit)
    ? null
    : { code: 5, out: "", err: `Unit ${unit}.timer not loaded.` };
}

function systemctlCall(state: Fake, line: string): Out {
  const show = /^systemctl show -p AllowedCPUs --value (\S+)$/.exec(line);
  if (show) return { code: 0, out: `${state.allowed.get(show[1] ?? "") ?? ""}\n`, err: "" };
  const set = /^systemctl set-property --runtime (\S+) AllowedCPUs=(.*?)(?: MemoryMin.*)?$/.exec(
    line,
  );
  if (set) state.allowed.set(set[1] ?? "", set[2] ?? "");
  return { code: 0, out: "", err: "" };
}
