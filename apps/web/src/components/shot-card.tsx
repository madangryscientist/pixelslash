import { Link } from "@tanstack/react-router";
import { Pill } from "@hackcove/ui";
import { changeCrop } from "../../../../packages/engine/src/report-crop.ts";
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
  return approvedEarlierLine(shot) ?? (shot.carriedFrom ? CARRIED : "no change");
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
    <li data-testid="snapshot-row" className="relative">
      <Link
        to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
        params={{ projectId, buildId, snapshotId: shot.id }}
        className="block h-full rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:border-slate-400"
      >
        <ShotThumb shot={shot} src={src} />
        <div className="mt-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            {label.component && (
              <p className="truncate text-xs text-slate-500" data-testid="shot-component">
                {label.component}
              </p>
            )}
            <p className="truncate font-medium" title={shot.name} data-testid="shot-story">
              {label.story}
            </p>
          </div>
          {!baseline && (holdsChange(shot) || shot.reviewState !== "pending") && (
            <ReviewChip state={shot.reviewState} by={shot.reviewedBy} />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {shotChips(shot, label).map((chip) => (
            <Pill key={chip} tone="slate">
              {chip}
            </Pill>
          ))}
        </div>
        {/* The judge's sentence (ob 1745) above the measured line, which always follows it. */}
        {shot.changeNote && (
          <p className="mt-2 text-sm text-slate-800" data-testid="shot-change-note">
            <span className="text-slate-500">Judge (local model): </span>
            {shot.changeNote}.
          </p>
        )}
        {shot.aiReview && (
          <p className="mt-2 text-sm text-slate-800" data-testid="shot-ai-labels">
            <span className="text-slate-500">AI: </span>
            {labelSummary(shot.aiReview.regions)}
          </p>
        )}
        <p className="mt-2 text-sm text-slate-600">{line}</p>
      </Link>
      {/* Beside the card's link, not in it: a link inside a link is not HTML. */}
      {shot.flakeId && (
        <span className="absolute top-4 left-4">
          <FlakyBadge projectId={projectId} flakeId={shot.flakeId} skipped={skippedFlaky(shot)} />
        </span>
      )}
    </li>
  );
}
