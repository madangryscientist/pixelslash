import { Link } from "@tanstack/react-router";
import { Body, BodyStrong, Caption, Card, Cluster, ClusterGrow, Pill, Stack } from "@hackcove/ui";
import { changeCrop } from "../../../../packages/engine/src/report-crop.ts";
import { IDENTICAL_NOTE } from "../../../../packages/engine/src/identical-note.ts";
import { a11yLine } from "#/components/a11y";
import type { Composition } from "#/components/composition";
import type { SnapshotView } from "#/db/review";
import { labelSummary } from "#/components/ai-notes";
import { FlakyBadge } from "#/components/flake";
import { ReviewChip } from "#/components/ui";
import { formatNumber } from "#/lib/format";
import { awaitsDecision, groupOf, holdsChange, skippedFlaky } from "#/lib/snapshot-groups";
import { type ShotLabel, shotChips } from "#/lib/shot-label";
import { coversMostOfShot } from "#/lib/thumb-crop";

const THUMB_BOX = "w-full overflow-hidden rounded-md bg-slate-100";

/** A thumbnail is as wide as its card and no taller than a crop of 3:2 or squatter would be; a sliver is not stretched into a box. */
const thumbAspect = (ratio: number) => ({ aspectRatio: String(Math.min(3, Math.max(1.5, ratio))) });

/**
 * The change, cropped from the branch shot with the measured boxes drawn on it. The server holds no
 * crop: this is the stored branch image seen through a window shaped like `changeCrop` (the
 * report's own maths, over the stored regions), so nothing new is written. The inner `<svg>` is
 * the window that clips; the outer one only fits it to the card.
 */
export function ShotThumb({ shot, src }: { shot: SnapshotView; src: string | undefined }) {
  if (!src) {
    return <div className={THUMB_BOX} style={thumbAspect(1.5)} data-testid="shot-thumb-missing" />;
  }
  const result = shot.diffResult;
  const crop =
    shot.diffStatus === "changed" && result
      ? changeCrop(result.regions, result.width, result.height)
      : null;
  if (!result || !crop) {
    // A new shot, or a changed one with no box to zoom on: the shot itself, top-aligned.
    return (
      <div className={THUMB_BOX} style={thumbAspect(1.5)} data-testid="shot-thumb">
        <img src={src} alt="" loading="lazy" className="size-full object-cover object-top" />
      </div>
    );
  }
  if (coversMostOfShot(result.regions, result)) {
    // The change spans the page: a tint over all of it hides the shot, so show it plainly with a badge.
    return (
      <div className={`${THUMB_BOX} relative`} style={thumbAspect(1.5)} data-testid="shot-thumb">
        <img src={src} alt="" loading="lazy" className="size-full object-cover object-top" />
        {/* Fixed colours, not the theme's: the badge sits on a screenshot, which has its own theme. */}
        <span
          className="absolute right-1.5 top-1.5 rounded bg-[rgba(15,23,42,0.85)] px-1.5 py-0.5 text-xs font-medium text-[#fff]"
          data-testid="shot-thumb-badge"
        >
          Most of the page changed
        </span>
      </div>
    );
  }
  return (
    <div className={THUMB_BOX} style={thumbAspect(crop.w / crop.h)} data-testid="shot-thumb">
      <svg
        viewBox={`0 0 ${crop.w} ${crop.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="size-full"
        role="img"
        aria-label="The changed region, cropped"
      >
        <svg
          x={0}
          y={0}
          width={crop.w}
          height={crop.h}
          viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}
          overflow="hidden"
        >
          <image href={src} width={result.branchWidth} height={result.branchHeight} />
          {result.regions
            .filter((region) => region.kind === "change")
            .map((region) => (
              <rect
                key={`${region.x}-${region.y}-${region.w}-${region.h}`}
                data-kind="change"
                x={region.x}
                y={region.y}
                width={region.w}
                height={region.h}
                fill="rgba(239, 68, 68, 0.2)"
                stroke="#ef4444"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
        </svg>
      </svg>
    </div>
  );
}

/** A new shot has no baseline to compare with; in the project's first build it is the baseline. */
const newLine = (baseline: boolean) =>
  baseline ? "sets the baseline" : "no baseline: not compared";

/** An unchanged shot that carries the branch's open change (ob 1712): no change here, one to decide. */
const CARRIED = "no change since the branch's last build; its change is still open";

/**
 * An unchanged shot whose change from the default branch was accepted on an earlier build of this
 * branch (ob 1722): "no change" alone would read as identical to the default branch.
 */
function approvedEarlierLine(shot: SnapshotView): string | null {
  const approved = shot.approvedEarlier;
  if (!approved) return null;
  const by = approved.reviewedBy ? ` by ${approved.reviewedBy}` : "";
  return `no change since build ${approved.commitSha.slice(0, 7)} · change from ${approved.defaultBranch} approved${by}`;
}

const unchangedLine = (shot: SnapshotView) => {
  if (awaitsDecision(shot)) return CARRIED;
  const settled = shot.diffResult?.settledBy ? IDENTICAL_NOTE : "no change";
  return approvedEarlierLine(shot) ?? (shot.carriedFrom ? CARRIED : settled);
};

/** The measured change, in the words the reviewer needs; nothing invented. */
export function measured(shot: SnapshotView, baseline: boolean): string {
  if (shot.diffStatus === "new") return newLine(baseline);
  if (shot.diffStatus === "removed") return "in the baseline only";
  if (shot.diffStatus === null) {
    return groupOf(shot) === "unmeasured" ? "not measured" : "not compared: needs a new baseline";
  }
  const result = shot.diffResult;
  if (!result) return "not compared";
  if (shot.diffStatus === "unchanged") return unchangedLine(shot);
  const boxes = result.regions.filter((region) => region.kind === "change").length;
  const changed = `${formatNumber(result.changedPixels)} px in ${boxes} box${boxes === 1 ? "" : "es"}`;
  if (result.sizeChanged) {
    const sizes = `${result.mainWidth}×${result.mainHeight} → ${result.branchWidth}×${result.branchHeight}`;
    return boxes > 0 ? `${changed} · size changed ${sizes}` : `size changed ${sizes}`;
  }
  return changed;
}

/** A composition-only shot's findings in a line: the gaps, and the special cases when there are any. */
export function findingsLine({ library, gaps, special }: Composition): string {
  const gap = `${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} not from ${library}`;
  return special.length > 0 ? `${gap} · ${special.length} special` : gap;
}

function GapsLine({ composition }: { composition: Composition | null | undefined }) {
  if (!composition) return null;
  return (
    <Body as="p" tone="muted" data-testid="shot-gaps">
      {findingsLine(composition)}
    </Body>
  );
}

function A11yLine({ diff }: { diff: SnapshotView["a11yDiff"] }) {
  const line = a11yLine(diff);
  if (!line) return null;
  return (
    <Body as="p" tone="muted" data-testid="shot-a11y">
      {line}
    </Body>
  );
}

/** The judge's sentence (ob 1745) and the AI's labels, above the measured line, which always follows them. */
function ShotNotes({ shot }: { shot: SnapshotView }) {
  return (
    <>
      {shot.changeNote && (
        <Body as="p" data-testid="shot-change-note">
          <Body tone="muted">Judge (local model): </Body>
          {shot.changeNote}.
        </Body>
      )}
      {shot.aiReview && (
        <Body as="p" data-testid="shot-ai-labels">
          <Body tone="muted">AI: </Body>
          {labelSummary(shot.aiReview.regions)}
        </Body>
      )}
      {!shot.aiReview && shot.aiPending && (
        <Body as="p" tone="muted" data-testid="shot-ai-pending">
          AI: explaining…
        </Body>
      )}
    </>
  );
}

/** One changed or new shot as a card: the crop, a readable name, its variants and its review. */
export function ShotCard({
  projectId,
  buildId,
  shot,
  label,
  src,
  baseline,
}: {
  projectId: string;
  buildId: string;
  shot: SnapshotView;
  label: ShotLabel;
  src: string | undefined;
  baseline: boolean;
}) {
  const line = measured(shot, baseline);
  return (
    <div data-testid="snapshot-row">
      <Card
        size="sm"
        badge={
          shot.flakeId ? (
            <FlakyBadge projectId={projectId} flakeId={shot.flakeId} skipped={skippedFlaky(shot)} />
          ) : undefined
        }
        render={(props) => (
          <Link
            to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
            params={{ projectId, buildId, snapshotId: shot.id }}
            {...props}
          />
        )}
      >
        <Stack gap="xs">
          <ShotThumb shot={shot} src={src} />
          <Cluster gap="xs" align="start" justify="between">
            <ClusterGrow>
              {/* Stacked: a truncated run is inline-block, so two would share a line. */}
              <Stack gap="xs">
                {label.component && (
                  <Caption as="p" truncate data-testid="shot-component">
                    {label.component}
                  </Caption>
                )}
                <BodyStrong as="p" truncate title={shot.name} data-testid="shot-story">
                  {label.story}
                </BodyStrong>
              </Stack>
            </ClusterGrow>
            {!baseline && (holdsChange(shot) || shot.reviewState !== "pending") && (
              <ReviewChip state={shot.reviewState} by={shot.reviewedBy} />
            )}
          </Cluster>
          <Cluster gap="xs" wrap>
            {shotChips(shot, label).map((chip) => (
              <Pill key={chip} tone="slate">
                {chip}
              </Pill>
            ))}
          </Cluster>
          <ShotNotes shot={shot} />
          <Body as="p" tone="muted">
            {line}
          </Body>
          <GapsLine composition={shot.composition} />
          <A11yLine diff={shot.a11yDiff} />
        </Stack>
      </Card>
    </div>
  );
}
