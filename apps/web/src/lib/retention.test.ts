import { describe, expect, test } from "vitest";
import { DAY_MS, buildExpiry, daysToExpiry, expiryLabel, retentionDaysOf } from "./retention";

describe("retentionDaysOf", () => {
  test("a whole number above zero turns retention on", () => {
    expect(retentionDaysOf("30")).toBe(30);
    expect(retentionDaysOf(" 7 ")).toBe(7);
  });

  test.each([undefined, "", "0", "-5", "abc", "1.5", "30d"])("%j leaves it off", (raw) => {
    expect(retentionDaysOf(raw)).toBeUndefined();
  });
});

describe("daysToExpiry", () => {
  const created = new Date("2026-10-01T12:00:00Z");

  test("counts whole days up to the end of the window, rounding a part day up", () => {
    expect(daysToExpiry(created, 30, created)).toBe(30);
    expect(daysToExpiry(created, 30, new Date(created.getTime() + 10 * DAY_MS + 1))).toBe(20);
    expect(daysToExpiry(created, 30, new Date(created.getTime() + 29 * DAY_MS))).toBe(1);
  });

  test("is zero or less once the window has passed", () => {
    expect(daysToExpiry(created, 30, new Date(created.getTime() + 30 * DAY_MS))).toBe(0);
    expect(daysToExpiry(created, 30, new Date(created.getTime() + 45 * DAY_MS))).toBeLessThan(0);
  });
});

describe("expiryLabel", () => {
  test("says days, and one day", () => {
    expect(expiryLabel(12)).toBe("expires in 12 days");
    expect(expiryLabel(1)).toBe("expires in 1 day");
  });
});

describe("buildExpiry", () => {
  const now = new Date("2026-10-28T00:00:00Z");
  const build = { createdAt: new Date(now.getTime() - 5 * DAY_MS), branch: "feat/x" };

  test("a PR build says when it expires", () => {
    expect(buildExpiry(build, "main", 30, now)).toBe("expires in 25 days");
  });

  test("says nothing with retention off", () => {
    expect(buildExpiry(build, "main", undefined, now)).toBeNull();
  });

  test("says nothing once past the window: the sweep may keep it as a baseline", () => {
    const old = { ...build, createdAt: new Date(now.getTime() - 31 * DAY_MS) };
    expect(buildExpiry(old, "main", 30, now)).toBeNull();
  });

  test("says nothing on the default branch", () => {
    expect(buildExpiry({ ...build, branch: "main" }, "main", 30, now)).toBeNull();
  });
});
