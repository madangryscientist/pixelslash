import { describe, expect, test } from "vitest";
import { STATE_FILE } from "../env/journal.ts";
import { LAPSE_UNIT, LIFETIME_S } from "../env/lapse.ts";
import { ON_FILE, runHelper } from "../env/reserve.ts";
import { SCOPE } from "../env/machine.ts";
import { fake, governor, ON, SELF, START, type Fake } from "./reserve-fake.ts";

const armCalls = (f: Fake): string[] => f.calls.filter((c) => c.startsWith("systemd-run "));
const lapseStops = (f: Fake): string[] =>
  f.calls.filter((c) => c === `systemctl stop ${LAPSE_UNIT}.timer`);

describe("the lapse", () => {
  test("a successful on arms one timer that runs the helper's own off, after clearing a stale one", async () => {
    const f = fake();
    f.timers.add(LAPSE_UNIT); // a failed earlier off left it
    await runHelper(f, ON);
    expect(LIFETIME_S).toBe(1800);
    expect(armCalls(f)).toEqual([
      `systemd-run --unit=${LAPSE_UNIT} --on-active=1800s --timer-property=AccuracySec=1s --collect ${SELF} off`,
    ]);
    // cleared first (it was loaded), then armed, and only after the scope is configured
    const stop = f.calls.indexOf(`systemctl stop ${LAPSE_UNIT}.timer`);
    const arm = f.calls.findIndex((c) => c.startsWith("systemd-run "));
    const scope = f.calls.findIndex((c) => c.includes(`set-property --runtime ${SCOPE}`));
    expect(stop).toBeGreaterThan(scope);
    expect(arm).toBeGreaterThan(stop);
  });

  test("when arming fails, on fails and puts everything back", async () => {
    const f = fake();
    f.allowed.set("user.slice", "0-11");
    f.failing.set("systemd-run", "no bus");
    await expect(runHelper(f, ON)).rejects.toThrow("no bus");
    expect(f.allowed.get("user.slice")).toBe("0-11");
    expect(f.allowed.get("system.slice") ?? "").toBe("");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(f.files.has(STATE_FILE)).toBe(false);
    expect(f.calls).toContain(`systemctl stop ${SCOPE}`);
  });

  test("off stops the timer, and succeeds when it is not loaded", async () => {
    const f = fake();
    await runHelper(f, ON);
    expect(f.timers.has(LAPSE_UNIT)).toBe(true);
    f.calls.length = 0;
    expect(await runHelper(f, ["off"])).toBe("restored");
    expect(lapseStops(f)).toHaveLength(1);
    expect(f.timers.has(LAPSE_UNIT)).toBe(false);

    // the timer already fired (and went): the lapse's own off finds it not loaded
    const g = fake();
    await runHelper(g, ON);
    g.timers.delete(LAPSE_UNIT);
    expect(await runHelper(g, ["off"])).toBe("restored");
  });

  test("off fails, keeping the record, when the timer cannot be stopped for another reason", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set(`stop ${LAPSE_UNIT}.timer`, "Access denied");
    await expect(runHelper(f, ["off"])).rejects.toThrow("Access denied");
    expect(f.files.has(STATE_FILE)).toBe(true);
  });

  test("renew arms a fresh timer and moves lapses forward, taking over a marker a killed helper left", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.files.set(ON_FILE, "4242\n"); // a killed helper's marker: its process is gone
    f.files.set("/proc/4242/comm", "bun\n");
    f.clock = START + 600_000;
    const before = armCalls(f).length;
    await runHelper(f, ["renew"]);
    expect(armCalls(f)).toHaveLength(before + 1);
    expect(f.timers.has(LAPSE_UNIT)).toBe(true);
    expect(f.files.has(ON_FILE)).toBe(false);
    const status = JSON.parse(await runHelper(f, ["status"]));
    expect(status.started).toBe(new Date(START).toISOString());
    expect(status.lapses).toBe(new Date(START + 600_000 + 1_800_000).toISOString());
    expect(status.age_s).toBe(600);
  });

  test("renew refuses with nothing reserved, an unusable record, or an older helper's record", async () => {
    const f = fake();
    await expect(runHelper(f, ["renew"])).rejects.toThrow("nothing reserved");
    f.files.set(STATE_FILE, "{}\n");
    await expect(runHelper(f, ["renew"])).rejects.toThrow("not usable");
    f.files.set(STATE_FILE, JSON.stringify(v1Journal()));
    await expect(runHelper(f, ["renew"])).rejects.toThrow("reserved by an older helper; run off");
    expect(armCalls(f)).toEqual([]);
    // and while another helper holds the marker, it does not start
    f.files.set(ON_FILE, "4242\n");
    f.files.set("/proc/4242/comm", "pixelslash-benc\n");
    await expect(runHelper(f, ["renew"])).rejects.toThrow("another helper is running");
    expect(f.files.get(ON_FILE)).toBe("4242\n");
  });

  test("renew that cannot re-arm ends the reservation rather than leave it unbounded", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set("systemd-run", "no bus");
    await expect(runHelper(f, ["renew"])).rejects.toThrow("no bus (restored)");
    expect(f.files.has(STATE_FILE)).toBe(false);
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
  });

  test("renew leaves the reservation alone when the old timer will not stop", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set(`stop ${LAPSE_UNIT}.timer`, "Access denied");
    await expect(runHelper(f, ["renew"])).rejects.toThrow("the lapse still stands");
    expect(f.files.has(STATE_FILE)).toBe(true);
    expect(f.timers.has(LAPSE_UNIT)).toBe(true);
  });

  test("renew whose release also fails keeps the record and says to run off", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.failing.set("systemd-run", "no bus");
    f.failing.set("set-property --runtime user.slice", "busy");
    const message = await runHelper(f, ["renew"]).then(
      () => "",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message).toContain("restoring also failed");
    expect(message).toContain("run off");
    expect(message).not.toContain("(restored)");
    expect(f.files.has(STATE_FILE)).toBe(true);
  });

  test("status 600 s in reports the age and the lapse 1800 s after the start", async () => {
    const f = fake();
    await runHelper(f, ON);
    f.clock = START + 600_000;
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      version: 3,
      active: true,
      age_s: 600,
      started: new Date(START).toISOString(),
      lapses: new Date(START + 1_800_000).toISOString(),
    });
  });

  test("status calls a timestamp no Date can hold unknown, and off still restores that record", async () => {
    const f = fake();
    f.files.set(
      STATE_FILE,
      JSON.stringify({ ...v1Journal(), version: 2, started: 1e300, lapses: 1e300 }),
    );
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      active: true,
      started: null,
      lapses: null,
      age_s: null,
    });
    expect(await runHelper(f, ["off"])).toBe("restored");
  });

  test("off restores from a version 1 record, which has no start", async () => {
    const f = fake();
    f.files.set(STATE_FILE, JSON.stringify(v1Journal()));
    f.files.set("/sys/devices/system/cpu/cpufreq/boost", "0");
    f.files.set("/sys/devices/system/cpu/cpu4/cpufreq/scaling_governor", "performance\n");
    expect(JSON.parse(await runHelper(f, ["status"]))).toMatchObject({
      active: true,
      reserved: [4, 5, 10, 11],
      started: null,
      lapses: null,
      age_s: null,
    });
    expect(await runHelper(f, ["off"])).toBe("restored");
    expect(f.files.get("/sys/devices/system/cpu/cpufreq/boost")).toBe("1");
    expect(governor(f, 4)).toBe("powersave");
    expect(f.files.has(STATE_FILE)).toBe(false);
  });
});

export function v1Journal(): object {
  return {
    version: 1,
    reserved: [4, 5, 10, 11],
    allowed: { "system.slice": "", "user.slice": "", "init.scope": "" },
    boost: "1",
    governors: { "4": "powersave", "5": "powersave", "10": "powersave", "11": "powersave" },
  };
}
