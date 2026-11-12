import { Caption, StackedBar, type StackedSegment, type TextTone, Text } from "@hackcove/ui-react";
import type { BuildSummary } from "#/db/build-list";
import type { BuildCounts } from "#/db/build-counts";

/** What the mix bar, the stripe and the to-review cell read off a build. */
export type MixBuild = Pick<BuildSummary, "branch" | "status" | "counts">;

type Slice = StackedSegment & { key: string };

/**
 * What a build's shots came to, in the order a reviewer cares about. Only what was measured is
 * painted as unchanged: a shot the server never compared, or could not compare against another
 * environment's baseline, is its own grey (`muted`, apart from the `neutral` unchanged) and its own words.
 *
 * Unchanged is the quiet slice: `neutral`, the dimmest of the kit's `VizTone`s (overlay1 in the dark
 * theme, against subtext0 for `muted`). In the light theme it is about as light as `muted`, and the
 * kit has no paler tone, so there the changed, new and removed hues set it apart, not its weight.
 */
function slicesOf(counts: BuildCounts): Slice[] {
  const slices: Slice[] = [
    { key: "changed", label: "changed", value: counts.changed, tone: "warn" },
    { key: "new", label: "new", value: counts.new, tone: "info" },
    { key: "removed", label: "removed", value: counts.removed, tone: "danger" },
    {
      key: "unmeasured",
      label: "not measured",
      value: counts.unmeasured + counts.rebaseline,
      tone: "muted",
    },
    { key: "unchanged", label: "unchanged", value: counts.unchanged, tone: "neutral" },
  ];
  return slices.filter((slice) => slice.value > 0);
}

export function MixBar({ counts }: { counts: BuildCounts }) {
  const slices = slicesOf(counts);
  if (slices.length === 0) return <Caption as="p">no shots</Caption>;
  return <StackedBar data-testid="snapshot-mix" size="sm" label="Shots" segments={slices} legend />;
}

/** The stripe down a row's leading edge: amber when work is waiting, the verdict otherwise. */
export function stripeToneOf(build: MixBuild | null): TextTone {
  if (!build) return "muted";
  if (build.counts.toReview > 0) return "warn";
  if (build.status === "failed" || build.status === "errored") return "danger";
  if (build.status === "passed") return "positive";
  return "muted";
}

/** A build in one of these statuses was never diffed, so "nothing to review" would claim a result. */
const UNMEASURED = new Set<MixBuild["status"]>(["uploading", "processing", "errored"]);

function ToReviewCount({ build, defaultBranch }: { build: MixBuild; defaultBranch: string }) {
  if (build.counts.toReview > 0) {
    return (
      <Text strong tone="warn" data-testid="to-review">
        {build.counts.toReview} to review
      </Text>
    );
  }
  return (
    <Text tone="muted" data-testid="to-review">
      {build.branch === defaultBranch && build.status === "passed"
        ? "auto-accepted"
        : "nothing to review"}
    </Text>
  );
}

/** "7 to review" in amber, "auto-accepted" for a build on the project's default branch (diff/process.ts accepts those), else a dash. */
export function ToReview({
  build,
  defaultBranch,
}: {
  build: MixBuild | null;
  defaultBranch: string;
}) {
  if (!build) return <Text tone="muted">n/a</Text>;
  if (UNMEASURED.has(build.status)) {
    return (
      <Text tone="muted" data-testid="to-review">
        not measured
      </Text>
    );
  }
  return (
    <>
      <ToReviewCount build={build} defaultBranch={defaultBranch} />
      {build.counts.skippedFlaky > 0 && (
        <Caption as="p" tone="warn" data-testid="skipped-flaky-count">
          {build.counts.skippedFlaky} skipped: flaky
        </Caption>
      )}
    </>
  );
}
