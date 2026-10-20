import { Link } from "@tanstack/react-router";
import { ReviewChip, StatusBadge, useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import type { DiffOptions } from "#/db/schema";
import { formatDateTime, formatNumber } from "#/lib/format";

const OPTION_KEYS: (keyof DiffOptions)[] = [
  "threshold",
  "minChangedPixels",
  "minChangedRatio",
  "mergeDistance",
  "minRegionArea",
  "noiseAmplitude",
  "maxShift",
];

export function SnapshotHeader({
  project,
  build,
  snapshot,
  position,
  total,
}: {
  project: { id: string; name: string };
  build: BuildView["build"];
  snapshot: SnapshotView;
  position: number;
  total: number;
}) {
  return (
    <>
      <p className="mb-1 text-sm text-neutral-600">
        <Link
          to="/projects/$projectId/builds/$buildId"
          params={{ projectId: project.id, buildId: build.id }}
          className="text-blue-700 hover:underline"
        >
          ← {build.branch} · {build.commitSha.slice(0, 7)}
        </Link>
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-neutral-600">
          {snapshot.platform} · {snapshot.browser} · {snapshot.viewport} · {snapshot.theme}
        </span>
        <StatusBadge status={build.status} />
        <ReviewChip state={snapshot.reviewState} by={snapshot.reviewedBy} />
        {snapshot.reviewedAt && (
          <span className="text-neutral-500">{formatDateTime(snapshot.reviewedAt)}</span>
        )}
        <span data-testid="position" className="ml-auto text-neutral-500">
          {position} of {total}
        </span>
      </div>
    </>
  );
}

/** Both sizes whenever they differ; the overlap is what the diff measured (invariant 1). */
export function SizeLine({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  let line = "Not compared: this shot has no baseline in a matching environment.";
  if (snapshot.diffStatus === "removed")
    line = "Removed: not compared. The baseline image is shown.";
  if (snapshot.diffStatus === "new")
    line = "No baseline: this shot is new, so nothing was compared.";
  if (snapshot.rebaselineNeeded)
    line = "Not compared: the baseline came from a different environment.";
  if (result) {
    const main = `${result.mainWidth}×${result.mainHeight}`;
    const branch = `${result.branchWidth}×${result.branchHeight}`;
    line = result.sizeChanged
      ? `Main ${main} · Branch ${branch} · compared at ${result.width}×${result.height} (the overlap). The rest was not painted as changed.`
      : `Both shots are ${main}; compared at ${result.width}×${result.height}.`;
  }
  return (
    <p data-testid="sizes" className="mb-4 text-sm text-neutral-600">
      {line}
    </p>
  );
}

/** Why a shot has no measurement, in the diff's own terms. */
function CompareNote({ snapshot }: { snapshot: SnapshotView }) {
  if (snapshot.diffStatus === "new")
    return (
      <p className="mt-2 text-sm text-neutral-600">
        No baseline: this shot is new and nothing was compared.
      </p>
    );
  if (snapshot.diffStatus === "removed")
    return (
      <p className="mt-2 text-sm text-neutral-600">
        Removed: the baseline has this shot, this build does not. It never blocks the build.
      </p>
    );
  if (snapshot.rebaselineNeeded)
    return (
      <p className="mt-2 text-sm text-neutral-600">
        The baseline was rendered in a different environment, so it was not compared. A new baseline
        is needed.
      </p>
    );
  return null;
}

export function MeasuredPanel({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  const rows: [string, string][] = [
    ["Changed pixels", formatNumber(result?.changedPixels ?? 0)],
    ["Antialiased pixels", formatNumber(result?.antialiasedPixels ?? 0)],
    ["Ignored pixels", formatNumber(result?.ignoredPixels ?? 0)],
    ["Specks dropped", result ? `${result.specks.count} (${result.specks.pixels} px)` : "—"],
  ];
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">Measured</h2>
      <dl className="space-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between">
            <dt className="text-neutral-600">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <CompareNote snapshot={snapshot} />
    </section>
  );
}

export function SettingsPanel({
  snapshot,
  options,
}: {
  snapshot: SnapshotView;
  options: DiffOptions;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-neutral-700">Diff options</h2>
      <dl data-testid="diff-options" className="space-y-1 text-sm">
        {OPTION_KEYS.map((key) => (
          <div key={key} className="flex justify-between">
            <dt className="text-neutral-600">{key}</dt>
            <dd>{options[key] ?? "engine default"}</dd>
          </div>
        ))}
      </dl>
      <h2 className="mt-4 mb-2 text-sm font-semibold text-neutral-700">Ignore areas</h2>
      <p className="text-sm text-neutral-600">
        {snapshot.ignore.length === 0
          ? "None: every pixel was measured."
          : `${snapshot.ignore.length} area${snapshot.ignore.length === 1 ? "" : "s"} skipped.`}
      </p>
    </section>
  );
}

export function ReviewBar({
  reviewable,
  busy,
  status,
  error,
  onAccept,
  onReject,
}: {
  reviewable: boolean;
  busy: boolean;
  status: string;
  error: string | null;
  onAccept: () => void;
  onReject: () => void;
}) {
  const hydrated = useHydrated();
  const disabled = !hydrated || busy || !reviewable;
  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4">
        <button
          type="button"
          disabled={disabled}
          onClick={onAccept}
          className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onReject}
          className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Reject
        </button>
        {!reviewable && (
          <span className="text-sm text-neutral-600">
            This build is {status}; a new build is needed to review it.
          </span>
        )}
        <span data-testid="keyboard-hint" className="text-sm text-neutral-500">
          j / k next · previous · a accept · r reject
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm">
          {error}
        </p>
      )}
    </>
  );
}
