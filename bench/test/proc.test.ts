import { describe, expect, test } from "vitest";
import { SCOPE } from "../env/reserve.ts";
import { spread } from "../src/perf/impl.ts";
import { Aggregate, type ProcIo, parseStat, scanForeign } from "../src/perf/proc.ts";

/** A stat line with the given state, flags and last CPU (fields 3, 9, 39). */
function stat(
  pid: number,
  comm: string,
  state: string,
  where: { flags: number; cpu: number },
): string {
  const { flags, cpu } = where;
  const after = Array.from({ length: 50 }, () => "0");
  after[0] = state;
  after[6] = String(flags);
  after[36] = String(cpu);
  return `${pid} (${comm}) ${after.join(" ")}`;
}

describe("parseStat", () => {
  test("reads state, flags and last CPU after the last paren", () => {
    expect(parseStat(stat(1, "bun", "R", { flags: 0, cpu: 5 }))).toEqual({
      comm: "bun",
      state: "R",
      kthread: false,
      cpu: 5,
    });
    expect(parseStat(stat(2, "kworker/4:1", "R", { flags: 0x20_0000, cpu: 4 }))?.kthread).toBe(
      true,
    );
  });

  test("a name with spaces and parens does not shift the fields", () => {
    expect(parseStat(stat(3, "a b) (c", "S", { flags: 0, cpu: 11 }))).toMatchObject({
      comm: "a b) (c",
      cpu: 11,
    });
  });

  test("garbage is null", () => {
    expect(parseStat("")).toBeNull();
    expect(parseStat("1 (x) R 1 2")).toBeNull();
  });
});

describe("scanForeign", () => {
  const files = new Map<string, string>([
    ["/proc/10/task/10/stat", stat(10, "firefox", "R", { flags: 0, cpu: 4 })],
    ["/proc/10/stat", stat(10, "firefox-main", "S", { flags: 0, cpu: 1 })],
    ["/proc/10/cgroup", "0::/user.slice/app.scope\n"],
    ["/proc/11/task/11/stat", stat(11, "bun", "R", { flags: 0, cpu: 5 })],
    ["/proc/11/cgroup", `0::/${SCOPE}\n`],
    ["/proc/12/task/12/stat", stat(12, "kworker/4:0", "R", { flags: 0x20_0000, cpu: 4 })],
    ["/proc/12/cgroup", "0::/\n"],
    ["/proc/13/task/13/stat", stat(13, "idle", "S", { flags: 0, cpu: 4 })],
    ["/proc/14/task/14/stat", stat(14, "elsewhere", "R", { flags: 0, cpu: 2 })],
    ["/proc/15/task/15/stat", stat(15, "sampler", "R", { flags: 0, cpu: 4 })],
  ]);
  const io: ProcIo = {
    pids: () => [10, 11, 12, 13, 14, 15],
    tids: (pid) => [pid],
    read: (path) => files.get(path) ?? null,
  };

  test("only running threads on a reserved CPU, outside the scope and the sampler, named after their process", () => {
    expect(scanForeign(io, [4, 5, 10, 11], SCOPE, 15)).toEqual([
      { pid: 10, comm: "firefox-main", kthread: false },
      { pid: 12, comm: "kworker/4:0", kthread: true },
    ]);
  });
});

describe("Aggregate", () => {
  test("names user tasks and kernel threads apart and averages the clock", () => {
    const agg = new Aggregate();
    agg.add([{ pid: 1, comm: "a", kthread: false }], [3_600_000, 3_800_000]);
    agg.add([{ pid: 2, comm: "ksoftirqd/4", kthread: true }], [3_700_000]);
    agg.add([{ pid: 1, comm: "a", kthread: false }], []);
    expect(agg.result()).toEqual({
      samples: 3,
      freqMhz: { mean: 3700, min: 3600, max: 3800 },
      foreign: { tasks: ["a[1]"], kernel: ["ksoftirqd/4"] },
    });
  });

  test("no clock readings is null, not zero", () => {
    expect(new Aggregate().result().freqMhz).toBeNull();
  });
});

describe("spread", () => {
  test("p95 over median", () => {
    expect(spread([10, 10, 10, 20])).toBe("2.00x");
    expect(spread([5])).toBe("1.00x");
  });
});
