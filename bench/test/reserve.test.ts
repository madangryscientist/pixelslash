import { describe, expect, test } from "vitest";
import { formatCpus, parseCpus } from "../env/cpulist.ts";
import {
  DEFAULT_CPUS,
  HELPER_VERSION,
  HelperError,
  ON_FILE,
  parseRequest,
  runHelper,
  SCOPE,
  STATE_FILE,
  type Host,
  type Out,
} from "../env/reserve.ts";

describe("cpu lists", () => {
  test("ranges, commas and spaces parse to a sorted set, and format back short", () => {
    expect(parseCpus("4-5,10-11")).toEqual([4, 5, 10, 11]);
    expect(parseCpus("11 10 4,5,5")).toEqual([4, 5, 10, 11]);
    expect(formatCpus([4, 5, 10, 11])).toBe("4-5,10-11");
    expect(formatCpus([0, 1, 2, 3, 6, 7, 8, 9])).toBe("0-3,6-9");
    expect(formatCpus([])).toBe("");
  });

  test.each(["", "a", "4-", "5-4", "4;rm", "$(id)", "4,,5", "-1", "4 -5", "2000"])(
    "rejects %j",
    (raw) => {
      expect(() => parseCpus(raw)).toThrow(/not a CPU/);
    },
  );
});

describe("argument validation", () => {
  test("on takes the defaults and a pid", () => {
    expect(parseRequest(["on", "--pid", "1234"])).toEqual({
      cmd: "on",
      cpus: parseCpus(DEFAULT_CPUS),
      mem: "4G",
      pid: 1234,
    });
    expect(parseRequest(["on", "--cpus", "2-3", "--mem", "512M", "--pid", "9"])).toMatchObject({
      cpus: [2, 3],
      mem: "512M",
    });
  });

  test.each([
    [[]],
    [["restart"]],
    [["on"]],
    [["on", "--pid"]],
    [["on", "--pid", "1", "--pid", "2"]],
    [["on", "--pid", "1"]],
    [["on", "--pid", "abc"]],
    [["on", "--pid", "5", "--mem", "4"]],
    [["on", "--pid", "5", "--mem", "4G; reboot"]],
    [["on", "--pid", "5", "--mem", "0G"]],
    [["on", "--pid", "5", "--cpus", "4,x"]],
    [["on", "--pid", "5", "--shell", "sh"]],
    [["off", "now"]],
    [["status", "--json"]],
  ])("refuses %j", (argv) => {
    expect(() => parseRequest(argv)).toThrow(/usage|takes|must|not a CPU|process id/);
  });
});

type Fake = Host & {
  files: Map<string, string>;
  calls: string[];
  /** Commands (joined) that fail once, mapped to their stderr. */
  failing: Map<string, string>;
  allowed: Map<string, string>;
  inside: boolean;
};

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

function fake(overrides: { uid?: number | null; pidOwner?: number | null } = {}): Fake {
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
    async exec(cmd): Promise<Out> {
      const line = cmd.join(" ");
      state.calls.push(line);
      for (const [needle, err] of state.failing)
        if (line.includes(needle)) {
          state.failing.delete(needle);
          return { code: 1, out: "", err };
        }
      const show = /^systemctl show -p AllowedCPUs --value (\S+)$/.exec(line);
      if (show) return { code: 0, out: `${allowed.get(show[1] ?? "") ?? ""}\n`, err: "" };
      const set =
        /^systemctl set-property --runtime (\S+) AllowedCPUs=(.*?)(?: MemoryMin.*)?$/.exec(line);
      if (set) allowed.set(set[1] ?? "", set[2] ?? "");
      return { code: 0, out: "", err: "" };
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

const ON = ["on", "--cpus", "4,5,10,11", "--mem", "4G", "--pid", "4242"];
const governor = (f: Fake, cpu: number) =>
  f.files.get(`/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`);

describe("on / off", () => {
  test("on reserves in order and off puts every value back", async () => {
    const f = fake();
    f.allowed.set("user.slice", "0-11");
    await runHelper(f, ON);
    const set = f.calls.filter((c) => c.startsWith("systemctl set-property"));
    expect(set.slice(0, 3)).toEqual([
      "systemctl set-property --runtime system.slice AllowedCPUs=0-3,6-9",
      "systemctl set-property --runtime user.slice AllowedCPUs=0-3,6-9",
      "systemctl set-property --runtime init.scope AllowedCPUs=0-3,6-9",
    ]);
    expect(set[3]).toBe(
      `systemctl set-property --runtime ${SCOPE} AllowedCPUs=4-5,10-11 MemoryMin=4G MemoryMax=4G MemorySwapMax=0`,
    );
    const start = f.calls.find((c) => c.includes("StartTransientUnit"));
    expect(start).toContain("busctl call -- org.freedesktop.systemd1 ");
    expect(start).toContain(`${SCOPE} fail 3 PIDs au 1 4242`);
    expect(start).toContain("Slice s -.slice");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("0");
    expect(governor(f, 4)).toBe("performance");
    expect(governor(f, 0)).toBe("powersave\n");
    expect(f.files.has(STATE_FILE)).toBe(true);

    f.inside = true;
    expect(await runHelper(f, ["off"])).toBe("restored");
    expect(f.allowed.get("user.slice")).toBe("0-11");
    expect(f.allowed.get("system.slice")).toBe("");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(governor(f, 4)).toBe("powersave");
    expect(f.files.has(STATE_FILE)).toBe(false);
    // the unit that had no CPU set loses its drop-in, so nothing is left behind
    expect(f.calls).toContain("systemctl daemon-reload");
  });

  test("off from inside the scope leaves it; from outside it stops it", async () => {
    const inside = fake();
    await runHelper(inside, ON);
    inside.inside = true;
    await runHelper(inside, ["off"]);
    expect(inside.calls.some((c) => c.startsWith("systemctl stop"))).toBe(false);

    const outside = fake();
    await runHelper(outside, ON);
    await runHelper(outside, ["off"]);
    expect(outside.calls).toContain(`systemctl stop ${SCOPE}`);
  });

  test("off with nothing reserved is a no-op, and twice is fine", async () => {
    const f = fake();
    expect(await runHelper(f, ["off"])).toBe("nothing reserved");
    await runHelper(f, ON);
    await runHelper(f, ["off"]);
    expect(await runHelper(f, ["off"])).toBe("nothing reserved");
  });

  test("a second on while reserved is refused and changes nothing", async () => {
    const f = fake();
    await runHelper(f, ON);
    const before = f.calls.length;
    await expect(runHelper(f, ON)).rejects.toThrow("already reserved");
    expect(f.calls.length).toBe(before);
  });

  test.each([
    ["the scope cannot start", "StartTransientUnit"],
    ["the scope's limits are refused", `set-property --runtime ${SCOPE}`],
    ["the second slice is refused", "set-property --runtime user.slice"],
  ])("when %s, on restores everything it had changed", async (_name, needle) => {
    const f = fake();
    f.allowed.set("user.slice", "0-11");
    f.failing.set(needle, "boom");
    await expect(runHelper(f, ON)).rejects.toThrow("boom");
    f.failing.clear();
    expect(f.allowed.get("user.slice")).toBe("0-11");
    expect(f.allowed.get("system.slice") ?? "").toBe("");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(governor(f, 4)).toBe("powersave");
    expect(f.files.has(STATE_FILE)).toBe(false);
  });

  test("a restore step that fails does not stop the others, and the record is kept for a retry", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set("set-property --runtime user.slice", "busy");
    await expect(runHelper(f, ["off"])).rejects.toThrow("busy");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(governor(f, 4)).toBe("powersave");
    expect(f.files.has(STATE_FILE)).toBe(true);
    f.failing.clear();
    expect(await runHelper(f, ["off"])).toBe("restored");
    expect(f.files.has(STATE_FILE)).toBe(false);
  });

  test("off drops the empty placeholder but keeps, and never runs, a record it cannot read", async () => {
    const f = fake();
    f.files.set(STATE_FILE, "{}\n");
    expect(await runHelper(f, ["off"])).toContain("nothing reserved");
    expect(f.files.has(STATE_FILE)).toBe(false);
    const hostile = '{"version":1,"reserved":[],"allowed":{"user.slice":"x; reboot"}}';
    f.files.set(STATE_FILE, hostile);
    await expect(runHelper(f, ["off"])).rejects.toThrow("leaving it");
    expect(f.files.get(STATE_FILE)).toBe(hostile);
    expect(f.calls.filter((c) => c.includes("reboot"))).toEqual([]);
  });

  test("off refuses while another helper's on is running, and ignores a marker a killed one left", async () => {
    const f = fake();
    f.files.set(ON_FILE, "4242\n");
    f.files.set("/proc/4242/comm", "pixelslash-benc\n");
    await expect(runHelper(f, ["off"])).rejects.toThrow("an `on` is still running");
    f.files.set("/proc/4242/comm", "bash\n");
    expect(await runHelper(f, ["off"])).toContain("nothing reserved");
    await runHelper(f, ON);
    expect(f.files.has(ON_FILE)).toBe(false);
  });

  test("status reports the live sets and whether a run is recorded", async () => {
    const f = fake();
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      version: HELPER_VERSION,
      active: false,
    });
    await runHelper(f, ON);
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      active: true,
      reserved: [4, 5, 10, 11],
      allowed: { "user.slice": "0-3,6-9" },
    });
  });
});

/** Run a request that must be refused; the message, and whether the machine was left alone. */
async function refusal(f: Fake, argv: string[]): Promise<{ message: string; untouched: boolean }> {
  const message = await runHelper(f, argv).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  const untouched = f.calls.every((c) => !c.includes("set-property")) && !f.files.has(STATE_FILE);
  return { message, untouched };
}

describe("what on refuses before touching anything", () => {
  test("half a core", async () => {
    const r = await refusal(fake(), ["on", "--cpus", "4,5,10", "--pid", "5"]);
    expect(r).toEqual({ message: expect.stringContaining("reserve whole cores"), untouched: true });
  });

  test("more memory than half the machine has", async () => {
    const r = await refusal(fake(), ["on", "--cpus", "4,5,10,11", "--mem", "9G", "--pid", "5"]);
    expect(r).toEqual({ message: expect.stringContaining("at most half"), untouched: true });
  });

  test("a CPU that is not online", async () => {
    const r = await refusal(fake(), ["on", "--cpus", "12-13", "--pid", "5"]);
    expect(r).toEqual({ message: expect.stringContaining("not online"), untouched: true });
  });

  test("every CPU, which would leave the host none", async () => {
    const r = await refusal(fake(), ["on", "--cpus", "0-11", "--pid", "5"]);
    expect(r).toEqual({ message: expect.stringContaining("at least two CPUs"), untouched: true });
  });

  test("a pid that is not the caller's", async () => {
    for (const pidOwner of [0, null]) {
      const r = await refusal(fake({ pidOwner }), ON);
      expect(r).toEqual({
        message: expect.stringContaining("not a process of the user"),
        untouched: true,
      });
    }
  });

  test("not run through sudo", async () => {
    const r = await refusal(fake({ uid: null }), ON);
    expect(r).toEqual({ message: expect.stringContaining("run through sudo"), untouched: true });
  });

  test("bad arguments are a HelperError the entry point can tell from a crash", () => {
    expect(() => parseRequest(["on", "--pid", "x"])).toThrow(HelperError);
  });
});
