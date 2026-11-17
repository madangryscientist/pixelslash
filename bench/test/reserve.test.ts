import { describe, expect, test } from "vitest";
import { formatCpus, parseCpus } from "../env/cpulist.ts";
import {
  DEFAULT_CPUS,
  HELPER_VERSION,
  MIN_HOST_CPUS,
  ON_FILE,
  parseRequest,
  runHelper,
} from "../env/reserve.ts";
import { HelperError } from "../env/error.ts";
import { SCOPE } from "../env/machine.ts";
import { STATE_FILE } from "../env/journal.ts";
import { LAPSE_UNIT } from "../env/lapse.ts";
import { fake, governor, ON, refusal } from "./reserve-fake.ts";

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
    [["renew", "now"]],
    [["status", "--json"]],
  ])("refuses %j", (argv) => {
    expect(() => parseRequest(argv)).toThrow(/usage|takes|must|not a CPU|process id/);
  });
});

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
    expect(inside.calls).not.toContain(`systemctl stop ${SCOPE}`);

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

  test("a restore step that fails does not stop the others, keeps the record and the lapse it had", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set("set-property --runtime user.slice", "busy");
    await expect(runHelper(f, ["off"])).rejects.toThrow("busy");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(governor(f, 4)).toBe("powersave");
    expect(f.files.has(STATE_FILE)).toBe(true);
    // the timer is stopped only after the restore, so the bound survives the failure
    expect(f.timers.has(LAPSE_UNIT)).toBe(true);
    f.failing.clear();
    expect(await runHelper(f, ["off"])).toBe("restored");
    expect(f.files.has(STATE_FILE)).toBe(false);
    expect(f.timers.size).toBe(0);
  });

  test("off drops the empty placeholder but keeps, and never runs, a record it cannot read", async () => {
    const f = fake();
    f.files.set(STATE_FILE, "{}\n");
    expect(await runHelper(f, ["off"])).toContain("nothing reserved");
    expect(f.files.has(STATE_FILE)).toBe(false);
    const hostile = `{"version":2,"reserved":[],"allowed":{"system.slice":"","user.slice":"x; reboot","init.scope":""},"started":1,"lapses":2}`;
    f.files.set(STATE_FILE, hostile);
    await expect(runHelper(f, ["off"])).rejects.toThrow("leaving it");
    expect(f.files.get(STATE_FILE)).toBe(hostile);
    expect(f.calls.filter((c) => c.includes("reboot"))).toEqual([]);
  });

  test("off refuses while another helper's on or renew is running, and ignores a marker a killed one left", async () => {
    const f = fake();
    f.files.set(ON_FILE, "4242\n");
    f.files.set("/proc/4242/comm", "pixelslash-benc\n");
    await expect(runHelper(f, ["off"])).rejects.toThrow("another helper is running");
    f.files.set("/proc/4242/comm", "bash\n");
    expect(await runHelper(f, ["off"])).toContain("nothing reserved");
    await runHelper(f, ON);
    expect(f.files.has(ON_FILE)).toBe(false);
  });

  test("status reports the live sets and whether a run is recorded", async () => {
    const f = fake();
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      version: 3,
      active: false,
      started: null,
      lapses: null,
      age_s: null,
    });
    expect(HELPER_VERSION).toBe(3);
    await runHelper(f, ON);
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      active: true,
      reserved: [4, 5, 10, 11],
      allowed: { "user.slice": "0-3,6-9" },
    });
  });
});

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
    expect(r).toEqual({
      message: expect.stringContaining("at least 4 CPUs; --cpus 0-11 leaves 0"),
      untouched: true,
    });
  });

  test("a list that leaves the host two CPUs, and nothing is run or written", async () => {
    const f = fake();
    const r = await refusal(f, ["on", "--cpus", "1-5,7-11", "--pid", "5"]);
    expect(MIN_HOST_CPUS).toBe(4);
    expect(r).toEqual({
      message: "the host must keep at least 4 CPUs; --cpus 1-5,7-11 leaves 2",
      untouched: true,
    });
    expect(f.calls).toEqual([]);
    expect(f.files.has(STATE_FILE)).toBe(false);
    expect(f.files.has(ON_FILE)).toBe(false);
  });

  test.each([["2-5,8-11"], ["4,5,10,11"]])(
    "the host keeps four CPUs or more: %s is accepted",
    async (cpus) => {
      const f = fake();
      await expect(runHelper(f, ["on", "--cpus", cpus, "--pid", "5"])).resolves.toContain(
        "reserved",
      );
    },
  );

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
