import { describe, expect, test } from "vitest";
import { HELPER_VERSION, SCOPE } from "../env/reserve.ts";
import {
  type EnvDeps,
  type EnvHeader,
  EnvUsageError,
  HELPER_PATH,
  INSTALL_COMMAND,
  beginEnv,
  defaultEnv,
  headerLines,
} from "../src/perf/env.ts";
import type { SamplerResult } from "../src/perf/proc.ts";

const ok = (out = "") => ({ code: 0, out, err: "" });

type Fake = EnvDeps & { log: string[]; undo: Array<() => Promise<void>>; inScope: boolean };

/** Fake machine: `helper` answers status, flips `inScope` on `on`; every call is logged in order. */
function fake(
  opts: {
    status?: { code: number; out: string; err: string };
    failOn?: boolean;
    stayOut?: boolean;
    holdOn?: Promise<void>;
    badSampler?: boolean;
    failOffOnce?: boolean;
  } = {},
): Fake {
  const log: string[] = [];
  const f: Fake = {
    log,
    undo: [],
    inScope: false,
    pid: 4242,
    bunVersion: "1.3.0",
    read: (path) => {
      if (path === "/proc/self/cgroup") return f.inScope ? `0::/${SCOPE}\n` : "0::/user.slice\n";
      if (path === "/proc/loadavg") return "0.42 0.30 0.20 1/900 1234\n";
      if (path === "/proc/cpuinfo") return "model name\t: Test CPU 9000\n";
      if (path === "/proc/sys/kernel/osrelease") return "7.2.8\n";
      if (path.endsWith("/boost")) return f.inScope ? "0\n" : "1\n";
      if (path.endsWith("/online")) return "0-11\n";
      if (path.endsWith("scaling_governor")) return "performance\n";
      return null;
    },
    exec: async (cmd) => {
      if (cmd[0] === "dotnet") return ok("10.0.100\n");
      if (cmd[0] === "systemctl") {
        const name = cmd[3];
        const unit = cmd[5];
        if (name === "AllowedCPUs") return ok(unit === SCOPE ? "4-5 10-11\n" : "0-3 6-9\n");
        return ok(name === "MemoryMin" || name === "MemoryMax" ? "4294967296\n" : "\n");
      }
      return { code: 1, out: "", err: "unexpected" };
    },
    helper: async (args) => {
      log.push(`helper ${args.join(" ")}`);
      if (args[0] === "status")
        return opts.status ?? ok(JSON.stringify({ version: HELPER_VERSION, active: false }));
      if (args[0] === "on") {
        if (opts.holdOn) {
          log.push("on begins");
          await opts.holdOn;
          log.push("on ends");
        }
        if (opts.failOn) return { code: 2, out: "", err: "refused" };
        f.inScope = !opts.stayOut;
      }
      if (args[0] === "off") {
        if (opts.failOffOnce && !log.includes("off failed")) {
          log.push("off failed");
          return { code: 1, out: "", err: "busy" };
        }
        f.inScope = false;
      }
      return ok();
    },
    startSampler: (cpus) => {
      log.push(`sampler start ${cpus.join(",")}`);
      return {
        stop: async (): Promise<SamplerResult | null> => {
          log.push("sampler stop");
          if (opts.badSampler) throw new Error("sampler died");
          return {
            samples: 8,
            freqMhz: { mean: 3700, min: 3650, max: 3720 },
            foreign: { tasks: [], kernel: ["ksoftirqd/4"] },
          };
        },
      };
    },
    onExit: (undo) => {
      log.push("onExit registered");
      f.undo.push(undo);
    },
  };
  return f;
}

const DEDICATED = { name: "dedicated", cpus: "4,5,10,11", mem: "4G" } as const;

describe("beginEnv none", () => {
  test("touches nothing and still records the machine", async () => {
    const f = fake();
    const header = await (await beginEnv(defaultEnv(), f)).finish();
    expect(f.log).toEqual([]);
    expect(header).toMatchObject({
      env: "none",
      cpuModel: "Test CPU 9000",
      kernel: "7.2.8",
      bun: "1.3.0",
      dotnet: "10.0.100",
      boost: "1",
      governor: "performance",
      reservedCpus: null,
      foreign: null,
    });
  });
});

describe("beginEnv dedicated", () => {
  test("off still runs when stopping the sampler throws", async () => {
    const f = fake({ badSampler: true });
    const session = await beginEnv(DEDICATED, f);
    await expect(session.finish()).rejects.toThrow("sampler died");
    expect(f.log.slice(-2)).toEqual(["sampler stop", "helper off"]);
    expect(f.inScope).toBe(false);
  });

  test("a failed off is tried again by the next restore", async () => {
    const f = fake({ failOffOnce: true });
    await beginEnv(DEDICATED, f);
    const undo = f.undo[0];
    await expect(undo?.()).rejects.toThrow("restoring the machine failed");
    await undo?.();
    expect(f.log.filter((l) => l === "helper off")).toHaveLength(2);
    expect(f.log.filter((l) => l === "sampler stop")).toHaveLength(1);
  });

  test("registers the restore before on, then restores in finish and reports what it measured", async () => {
    const f = fake();
    const session = await beginEnv(DEDICATED, f);
    expect(f.log).toEqual([
      "helper status",
      "onExit registered",
      "sampler start 4,5,10,11",
      "helper on --cpus 4-5,10-11 --mem 4G --pid 4242",
    ]);
    const header = await session.finish();
    expect(f.log.slice(4)).toEqual(["sampler stop", "helper off"]);
    expect(header).toMatchObject({
      env: "dedicated",
      reservedCpus: "4-5,10-11",
      hostCpus: "0-3,6-9",
      memoryMin: "4294967296",
      memoryMax: "4294967296",
      boost: "0",
      freqMhz: { mean: 3700 },
      foreign: { tasks: [], kernel: ["ksoftirqd/4"] },
    });
  });

  test("the registered restore and finish together call off once", async () => {
    const f = fake();
    const session = await beginEnv(DEDICATED, f);
    await Promise.all([session.finish(), ...f.undo.map((u) => u())]);
    await f.undo[0]?.();
    expect(f.log.filter((l) => l === "helper off")).toHaveLength(1);
  });

  test("an on that fails still leaves the restore registered, and it runs off", async () => {
    const f = fake({ failOn: true });
    await expect(beginEnv(DEDICATED, f)).rejects.toThrow("reserving the cores failed: refused");
    expect(f.undo).toHaveLength(1);
    await f.undo[0]?.();
    expect(f.log.at(-1)).toBe("helper off");
    expect(f.log).toContain("sampler stop");
  });

  test("a signal while on is still running waits for it before off", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fake({ holdOn: gate.promise });
    const starting = beginEnv(DEDICATED, f).catch(() => null);
    while (!f.log.includes("on begins")) await Bun.sleep(1);
    const undoing = f.undo[0]?.();
    await Bun.sleep(5);
    expect(f.log).not.toContain("helper off");
    gate.resolve();
    await undoing;
    await starting;
    expect(f.log.indexOf("on ends")).toBeLessThan(f.log.indexOf("helper off"));
  });

  test("a failing off is an error, not a quiet success", async () => {
    const f = fake();
    const session = await beginEnv(DEDICATED, f);
    f.helper = async () => ({ code: 1, out: "", err: "stuck" });
    await expect(session.finish()).rejects.toThrow("restoring the machine failed: stuck");
  });

  test("no sudo or no helper: a usage error naming the install command, nothing touched", async () => {
    const f = fake({ status: { code: 1, out: "", err: "sudo: a password is required" } });
    const err = await beginEnv(DEDICATED, f).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvUsageError);
    expect(String(err)).toContain(INSTALL_COMMAND);
    expect(String(err)).toContain(HELPER_PATH);
    expect(f.log).toEqual(["helper status"]);
    expect(f.undo).toEqual([]);
  });

  test("an out-of-date helper is refused", async () => {
    const f = fake({ status: ok(JSON.stringify({ version: HELPER_VERSION + 1, active: false })) });
    await expect(beginEnv(DEDICATED, f)).rejects.toThrow("out of date");
  });

  test("a reservation left by a dead run is refused, naming the way out", async () => {
    const f = fake({ status: ok(JSON.stringify({ version: HELPER_VERSION, active: true })) });
    await expect(beginEnv(DEDICATED, f)).rejects.toThrow(`${HELPER_PATH} off`);
  });

  test("a runner that did not land in the scope is an error", async () => {
    const f = fake({ stayOut: true });
    await expect(beginEnv(DEDICATED, f)).rejects.toThrow("not in pixelslash-bench.scope");
  });
});

describe("headerLines", () => {
  const base: EnvHeader = {
    env: "none",
    cpuModel: "Test CPU 9000",
    kernel: "7.2.8",
    bun: "1.3.0",
    dotnet: "10.0.100",
    reservedCpus: null,
    hostCpus: null,
    memoryMin: null,
    memoryMax: null,
    boost: "1",
    governor: "performance",
    freqMhz: null,
    loadStart: "0.42",
    loadEnd: "0.50",
    foreign: null,
  };

  test("a dedicated run whose sampler returned nothing says so rather than stay silent", () => {
    const lines = headerLines({ ...base, env: "dedicated", reservedCpus: "4-5" });
    expect(lines.slice(3)).toEqual([
      "reserved cores' frequency: not measured (the sampler returned nothing)",
      "other tasks on the reserved CPUs: not measured (the sampler returned nothing)",
    ]);
  });

  test("none prints the machine in two lines", () => {
    expect(headerLines(base)).toEqual([
      "env: none · Test CPU 9000 · kernel 7.2.8 · bun 1.3.0 · dotnet 10.0.100",
      "boost on · governor performance · host load 0.42 at start, 0.50 at end",
    ]);
  });

  test("dedicated adds the reservation, the measured clock and the foreign tasks by name", () => {
    const lines = headerLines({
      ...base,
      env: "dedicated",
      boost: "0",
      reservedCpus: "4-5,10-11",
      hostCpus: "0-3,6-9",
      memoryMin: "4294967296",
      memoryMax: "4294967296",
      freqMhz: { mean: 3700.4, min: 3650, max: 3720 },
      foreign: { tasks: ["firefox[12]"], kernel: ["ksoftirqd/4"] },
    });
    expect(lines[1]).toContain("boost off");
    expect(lines.slice(2)).toEqual([
      "reserved CPUs 4-5,10-11 (host kept 0-3,6-9) · memory min 4294967296 max 4294967296",
      "reserved cores ran at 3700 MHz (min 3650, max 3720)",
      "other tasks seen on the reserved CPUs: 1 (firefox[12]); kernel threads: ksoftirqd/4",
    ]);
  });
});
