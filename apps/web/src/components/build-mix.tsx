import type { BuildCounts, BuildSummary } from "#/db/review";
import { SNAPSHOT_GROUPS } from "#/lib/snapshot-groups";
import { formatNumber } from "#/lib/format";

/** What the mix bar, the stripe and the to-review cell read off a build. */
export type MixBuild = Pick<BuildSummary, "branch" | "status" | "counts">;

type Slice = { key: string; label: string; count: number; colour: string };

/**
 * What a build's shots came to, in the order a reviewer cares about. Only what was measured is
 * painted as unchanged: a shot the server never compared, or could not compare against another
 * environment's baseline, is its own grey and its own words.
 */
function slicesOf(counts: BuildCounts): Slice[] {
  return [
    { key: "changed", label: "changed", count: counts.changed, colour: "var(--ps-changed)" },
    { key: "new", label: "new", count: counts.new, colour: "var(--ps-new)" },
    { key: "removed", label: "removed", count: counts.removed, colour: "var(--ps-removed)" },
    {
      key: "unmeasured",
      label: "not measured",
      count: counts.unmeasured + counts.rebaseline,
      colour: "var(--ps-unmeasured)",
    },
    { key: "unchanged", label: "unchanged", count: counts.unchanged, colour: "var(--ps-same)" },
  ].filter((slice) => slice.count > 0);
}

/** Every shot the build holds, removed markers included: the size of the bar's whole. */
export function totalOf(counts: BuildCounts): number {
  return SNAPSHOT_GROUPS.reduce((sum, group) => sum + counts[group], 0);
}

export function MixBar({ counts }: { counts: BuildCounts }) {
  const slices = slicesOf(counts);
  const total = totalOf(counts);
  return (
    <div data-testid="snapshot-mix">
      <div
        role="img"
        aria-label={slices.map((s) => `${s.count} ${s.label}`).join(", ") || "no shots"}
        className="flex h-1.5 w-full overflow-hidden rounded-[3px] bg-(--ps-same)"
      >
        {slices.map((slice) => (
          <i
            key={slice.key}
            className="block h-full"
            style={{ width: `${(slice.count / total) * 100}%`, background: slice.colour }}
          />
        ))}
      </div>
      <p className="mt-1.25 text-xs text-slate-400">
        {slices.length === 0
          ? "no shots"
          : slices.map((s) => `${formatNumber(s.count)} ${s.label}`).join(" · ")}
      </p>
    </div>
  );
}

/** The stripe down a row's left edge: amber when work is waiting, the verdict otherwise. */
export function stripeOf(build: MixBuild): string {
  if (build.counts.toReview > 0) return "var(--ps-changed)";
  if (build.status === "failed" || build.status === "errored") return "var(--ps-removed)";
  if (build.status === "passed") return "var(--ps-ok)";
  return "var(--ps-unmeasured)";
}

/** A build in one of these statuses was never diffed, so "nothing to review" would claim a result. */
const UNMEASURED = new Set<MixBuild["status"]>(["uploading", "processing", "errored"]);

/** "7 to review" in amber, "auto-accepted" for a build on the project's default branch (diff/process.ts accepts those), else a dash. */
export function ToReview({
  build,
  defaultBranch,
}: {
  build: MixBuild | null;
  defaultBranch: string;
}) {
  if (!build) return <span className="text-slate-400">—</span>;
  if (UNMEASURED.has(build.status)) {
    return (
      <span data-testid="to-review" className="text-sm text-slate-400">
        not measured
      </span>
    );
  }
  if (build.counts.toReview > 0) {
    return (
      <span data-testid="to-review" className="font-bold text-(--ps-warn)">
        {build.counts.toReview} to review
      </span>
    );
  }
  return (
    <span data-testid="to-review" className="text-sm text-slate-400">
      {build.branch === defaultBranch && build.status === "passed"
        ? "auto-accepted"
        : "nothing to review"}
    </span>
  );
}
