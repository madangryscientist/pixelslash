import { describe, expect, test, vi } from "vitest";
import type { SnapshotView } from "#/db/review";
import { shotLabeller } from "#/lib/shot-label";
import { byTestId } from "#/test/by-test-id";
import { renderRouted } from "#/test/render-routed";
import { snapshotView } from "#/test/snapshot-view";
import type { Composition } from "./composition";
import { ShotCard } from "./shot-card";

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
