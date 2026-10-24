/**
 * What ran on the reserved CPUs while a dedicated bench ran, read from /proc (ob 1947): a sample
 * lists the threads in state R whose last CPU (`stat` field 39) is a reserved one and that are not
 * in the bench's own scope, and reads the reserved cores' clock. A task that is not running keeps
 * its old "last CPU", so only R counts. Per-CPU kernel threads cannot be moved by a cpuset; they
 * are named, not counted as foreign tasks.
 */
const PF_KTHREAD = 0x20_0000;

export type Stat = { comm: string; state: string; kthread: boolean; cpu: number };

/** `pid (comm) S ...`: comm may hold spaces and parens, so split at the last `)`. */
export function parseStat(text: string): Stat | null {
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (open < 0 || close < open) return null;
  // after the name, the first word is field 3 (state); flags is field 9, processor field 39
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const flags = Number(rest[6]);
  const cpu = Number(rest[36]);
  const state = rest[0];
  if (state === undefined || !Number.isInteger(flags) || !Number.isInteger(cpu)) return null;
  return { comm: text.slice(open + 1, close), state, kthread: (flags & PF_KTHREAD) !== 0, cpu };
}

/** The /proc the sampler walks; a test supplies a map. */
export type ProcIo = {
  pids(): number[];
  tids(pid: number): number[];
  read(path: string): string | null;
};

export type Seen = { pid: number; comm: string; kthread: boolean };

/** A thread is named after its process (`bun`, not `JITWorker`); a kernel thread keeps its own name. */
function nameOf(io: ProcIo, pid: number, stat: Stat): string {
  if (stat.kthread) return stat.comm;
  return parseStat(io.read(`/proc/${pid}/stat`) ?? "")?.comm ?? stat.comm;
}

/** Threads of one process running on `reserved` now, unless the process is in the scope. */
function runningOn(io: ProcIo, pid: number, reserved: number[], scope: string): Seen[] {
  const found: Seen[] = [];
  let inScope: boolean | null = null;
  for (const tid of io.tids(pid)) {
    const stat = parseStat(io.read(`/proc/${pid}/task/${tid}/stat`) ?? "");
    if (stat?.state !== "R" || !reserved.includes(stat.cpu)) continue;
    inScope ??= (io.read(`/proc/${pid}/cgroup`) ?? "").includes(scope);
    if (!inScope) found.push({ pid, comm: nameOf(io, pid, stat), kthread: stat.kthread });
  }
  return found;
}

/** Threads running on `reserved` now that are not in the scope or the sampler itself. */
export function scanForeign(io: ProcIo, reserved: number[], scope: string, self: number): Seen[] {
  return io
    .pids()
    .filter((pid) => pid !== self)
    .flatMap((pid) => runningOn(io, pid, reserved, scope));
}

export type Foreign = {
  /** Distinct user-space processes seen running on a reserved CPU, by name; should be empty. */
  tasks: string[];
  /** Kernel threads seen there (they cannot be moved), by name. */
  kernel: string[];
};

export type SamplerResult = {
  samples: number;
  freqMhz: { mean: number; min: number; max: number } | null;
  foreign: Foreign;
};

/** Folds samples into the result the sampler prints when it is stopped. */
export class Aggregate {
  private samples = 0;
  private freqSum = 0;
  private freqN = 0;
  private freqMin = Infinity;
  private freqMax = 0;
  private readonly tasks = new Set<string>();
  private readonly kernel = new Set<string>();

  add(seen: Seen[], freqKhz: number[]): void {
    this.samples += 1;
    for (const s of seen)
      (s.kthread ? this.kernel : this.tasks).add(s.kthread ? s.comm : `${s.comm}[${s.pid}]`);
    for (const khz of freqKhz) {
      const mhz = khz / 1000;
      this.freqSum += mhz;
      this.freqN += 1;
      this.freqMin = Math.min(this.freqMin, mhz);
      this.freqMax = Math.max(this.freqMax, mhz);
    }
  }

  result(): SamplerResult {
    return {
      samples: this.samples,
      freqMhz:
        this.freqN === 0
          ? null
          : { mean: this.freqSum / this.freqN, min: this.freqMin, max: this.freqMax },
      foreign: { tasks: [...this.tasks].toSorted(), kernel: [...this.kernel].toSorted() },
    };
  }
}
