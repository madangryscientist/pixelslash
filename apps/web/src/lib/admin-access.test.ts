import { describe, expect, test } from "vitest";
import { isAdmin } from "./admin-access";

describe("isAdmin", () => {
  test("a listed login is an admin, whatever its case", () => {
    expect(isAdmin({ login: "Ada" }, "ada,grace")).toBe(true);
    expect(isAdmin({ login: "grace" }, " Ada, Grace,, ")).toBe(true);
  });

  test("a signed-in user who is not listed is not", () => {
    expect(isAdmin({ login: "linus" }, "ada,grace")).toBe(false);
  });

  test("an unset or empty list admits no one", () => {
    expect(isAdmin({ login: "ada" }, undefined)).toBe(false);
    expect(isAdmin({ login: "ada" }, "")).toBe(false);
  });

  test("signed out is not an admin, even with a list", () => {
    expect(isAdmin(null, "ada")).toBe(false);
  });
});
