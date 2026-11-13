import { describe, expect, test } from "vitest";
import { walkAround } from "./review-walk";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("walkAround", () => {
  test("names the shot's place and its neighbours in the build's order", () => {
    expect(walkAround(rows, "b")).toEqual({
      shot: { id: "b" },
      position: 2,
      total: 3,
      previousId: "a",
      nextId: "c",
    });
  });

  test("the first has no previous, the last no next, and a stranger is null", () => {
    expect(walkAround(rows, "a")).toMatchObject({ position: 1, previousId: null, nextId: "b" });
    expect(walkAround(rows, "c")).toMatchObject({ position: 3, previousId: "b", nextId: null });
    expect(walkAround(rows, "z")).toBeNull();
  });
});
