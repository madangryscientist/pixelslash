import { describe, expect, test } from "vitest";
import { formatDay, formatRelative } from "./format";

const now = new Date("2026-10-21T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelative", () => {
  test("reads to one unit, and falls back to the day after two weeks", () => {
    expect(formatRelative(ago(20_000), now)).toBe("just now");
    expect(formatRelative(ago(5 * MIN), now)).toBe("5 min ago");
    expect(formatRelative(ago(2 * HOUR + 40 * MIN), now)).toBe("2 h ago");
    expect(formatRelative(ago(30 * HOUR), now)).toBe("yesterday");
    expect(formatRelative(ago(3 * DAY), now)).toBe("3 d ago");
    expect(formatRelative(ago(20 * DAY), now)).toBe("1 Oct");
  });

  test("a time in the future (clock skew) reads as just now, never negative", () => {
    expect(formatRelative(new Date(now.getTime() + HOUR), now)).toBe("just now");
  });
});

test("formatDay is the UTC day and month", () => {
  expect(formatDay(new Date("2026-10-19T23:59:00Z"))).toBe("19 Oct");
});
