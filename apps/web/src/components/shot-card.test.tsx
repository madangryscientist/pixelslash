import { describe, expect, test, vi } from "vitest";
import type { SnapshotView } from "#/db/review";
import type { DiffResult } from "#/db/schema";
import { shotLabeller } from "#/lib/shot-label";
import { byTestId } from "#/test/by-test-id";
import { renderRouted } from "#/test/render-routed";
import { snapshotView } from "#/test/snapshot-view";
import type { Composition } from "./composition";
import { ShotCard, measured } from "./shot-card";

vi.mock("#/components/flake", () => ({ FlakyBadge: () => null }));

/**
 * The build page's card for one shot: that it carries a composition shot's findings line, and
 * only when the shot has findings. The wording is `findingsLine`'s (composition.test.tsx).
 */

const composition: Composition = {
  library: "Hack Cove UI",
  gaps: [
    {
      kind: "class",
      selector: "#go",
      tag: "button",
      classes: ["mt-7"],
      style: null,
      box: { x: 10, y: 10, width: 10, height: 10 },
    },
  ],
  special: [],
};

const card = (s: SnapshotView) =>
  renderRouted(
    <ShotCard
      projectId="p1"
      buildId="b1"
      shot={s}
      label={shotLabeller([s.name])(s.name)}
      src={undefined}
      baseline={false}
    />,
  );

describe("the build page's card for a composition shot", () => {
  test("states the gaps the shot has", async () => {
    expect(byTestId(await card(snapshotView({ composition })), "shot-gaps")).toBe(
      "1 gap not from Hack Cove UI",
    );
  });

  test("a shot without findings has no findings line", async () => {
    expect(byTestId(await card(snapshotView({ composition: null })), "shot-gaps")).toBeNull();
  });
});

const approvedEarlier = (mainChangedSince: boolean): SnapshotView["approvedEarlier"] => ({
  snapshotId: "s0",
  buildId: "b0",
  commitSha: "61f0c17000000000000000000000000000000000",
  reviewedBy: "ada",
  reviewedAt: new Date(0),
  defaultBranch: "main",
  mainChangedSince,
});

const unchangedResult: DiffResult = {
  changedPixels: 0,
  antialiasedPixels: 0,
  ignoredPixels: 0,
  ignored: [],
  specks: { count: 0, pixels: 0 },
  regions: [],
  width: 1280,
  height: 640,
  mainWidth: 1280,
  mainHeight: 640,
  branchWidth: 1280,
  branchHeight: 640,
  sizeChanged: false,
};

const approvedLine = (mainChangedSince: boolean) =>
  measured(
    snapshotView({
      diffStatus: "unchanged",
      diffResult: unchangedResult,
      reviewState: "accepted",
      approvedEarlier: approvedEarlier(mainChangedSince),
    }),
    false,
  );

describe("the card line for a shot approved earlier", () => {
  test("ends with 'has changed since' when main moved after the approval", () => {
    expect(approvedLine(true)).toBe(
      "no change since build 61f0c17 · change from main approved by ada · main has changed since",
    );
  });

  test("does not say it when main has not moved", () => {
    expect(approvedLine(false)).toBe(
      "no change since build 61f0c17 · change from main approved by ada",
    );
  });
});
