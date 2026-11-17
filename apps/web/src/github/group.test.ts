import { describe, expect, test } from "vitest";
import { emptyCounts } from "#/db/build-counts";
import type { BuildStatus } from "#/db/schema";
import { type GroupMember, groupState } from "./group";

/** One status for a project and its subprojects on a commit, from each one's newest build there. */

const member = (
  name: string,
  status: BuildStatus | null,
  counts: Partial<ReturnType<typeof emptyCounts>> = {},
  top = false,
): GroupMember => ({
  projectId: `id-${name}`,
  name,
  top,
  build: status === null ? null : { id: `b-${name}`, projectId: `id-${name}`, status, error: null },
  counts: { ...emptyCounts(), ...counts },
});

const P = "id-web";

describe("the group's status (the wording group-status.test.ts does not reach)", () => {
  test("several failed builds are named together, and the top project is named where changes wait", () => {
    const failed = groupState(
      [member("a", "failed", { rejected: 1 }), member("b", "errored"), member("c", "processing")],
      P,
    );
    expect(failed).toMatchObject({ state: "failure", description: "2 builds failed: a, b" });
    expect(failed.target).toEqual({ projectId: P });
    const withTop = groupState(
      [member("web", "changes", { toReview: 1 }, true), member("a", "changes", { toReview: 1 })],
      P,
    );
    expect(withTop.description).toBe("2 changes to review in web and 1 subproject");
  });
});
