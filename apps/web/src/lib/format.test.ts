import { describe, expect, test } from "vitest";
import { formatDay, formatDuration, formatRelative } from "./format";

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

const nb = (text: string) => text.replaceAll(" ", "\u00a0");

test("formatDuration reads in the unit a person thinks in, with non-breaking spaces", () => {
  expect(formatDuration(0)).toBe(nb("0 ms"));
  expect(formatDuration(840.4)).toBe(nb("840 ms"));
  expect(formatDuration(1_240)).toBe(nb("1.2 s"));
  expect(formatDuration(18_400)).toBe(nb("18 s"));
  expect(formatDuration(75_000)).toBe(nb("1 min 15 s"));
  expect(formatDuration(75_000)).not.toContain(" ");
});

describe("formatDuration past a minute", () => {
  const S = 1000;
  test("the boundaries read in at most two units", () => {
    expect(formatDuration(59 * S)).toBe(nb("59 s"));
    expect(formatDuration(61 * S)).toBe(nb("1 min 1 s"));
    expect(formatDuration(59 * MIN)).toBe(nb("59 min 0 s"));
    expect(formatDuration(61 * MIN)).toBe(nb("1 h 1 min"));
    expect(formatDuration(23 * HOUR + 59 * MIN)).toBe(nb("23 h 59 min"));
    expect(formatDuration(25 * HOUR)).toBe(nb("1 d 1 h"));
    expect(formatDuration(13 * DAY)).toBe(nb("13 d 0 h"));
  });

  test("a value a second short of a band stays in the lower one", () => {
    expect(formatDuration(24 * HOUR - 1000)).toBe(nb("23 h 59 min"));
    expect(formatDuration(HOUR - 1000)).toBe(nb("59 min 59 s"));
  });

  test("the stuck build from the operator page reads in days and hours", () => {
    expect(formatDuration(18_909 * MIN + 4 * S)).toBe(nb("13 d 3 h"));
  });

  test("exact keeps minutes and seconds past an hour", () => {
    expect(formatDuration(18_909 * MIN + 4 * S, { exact: true })).toBe(nb("18909 min 4 s"));
    expect(formatDuration(61 * MIN, { exact: true })).toBe(nb("61 min 0 s"));
  });
});
