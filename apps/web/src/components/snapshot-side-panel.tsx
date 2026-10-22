import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AiExplanation } from "#/components/ai-notes";
import type { SnapshotView } from "#/db/review";
import type { DiffOptions, OptionSource } from "#/db/schema";
import { formatDateTime, formatNumber } from "#/lib/format";
import { awaitsDecision } from "#/lib/snapshot-groups";

const OPTION_KEYS: (keyof DiffOptions)[] = [
  "threshold",
  "minChangedPixels",
  "minChangedRatio",
  "mergeDistance",
  "minRegionArea",
  "noiseAmplitude",
  "maxShift",
];

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
      {children}
    </h2>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

/** Both sizes whenever they differ; the overlap is what the diff measured (invariant 1). */
function SizeLine({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  let line = "Not compared: this shot has no baseline in a matching environment.";
  if (snapshot.diffStatus === "removed")
    line = "Removed: not compared. The baseline image is shown; it never blocks the build.";
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
    <p data-testid="sizes" className="mt-2 text-sm text-slate-600">
      {line}
    </p>
  );
}

const MEASURED_BY = { ci: "CI (the CLI)", server: "PixelSlash server" } as const;

/** Where the diff ran and on which engine (ob 1727); nothing for a shot measured before it was recorded. */
function Provenance({ snapshot }: { snapshot: SnapshotView }) {
  if (!snapshot.measuredBy) return null;
  return (
    <>
      <Row label="Measured by">
        <span data-testid="measured-by">{MEASURED_BY[snapshot.measuredBy]}</span>
      </Row>
      <Row label="Engine">{snapshot.engineVersion ?? "unknown"}</Row>
    </>
  );
}

/** What the diff measured, or that it measured nothing: an unmeasured shot is never "0 changed". */
function Measured({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  if (!result) {
    return (
      <section>
        <Heading>Measured</Heading>
        <p className="text-sm font-medium">Not measured</p>
        {snapshot.diffError && (
          <p data-testid="diff-error" className="mt-1 text-sm text-red-700">
            {snapshot.diffError}
          </p>
        )}
        <dl className="mt-2 space-y-1 text-sm empty:hidden">
          <Provenance snapshot={snapshot} />
        </dl>
        <SizeLine snapshot={snapshot} />
      </section>
    );
  }
  const boxes = result.regions.filter((region) => region.kind === "change").length;
  return (
    <section>
      <Heading>Measured</Heading>
      <dl className="space-y-1 text-sm">
        <Row label="Changed px">{formatNumber(result.changedPixels)}</Row>
        <Row label="Changed regions">{boxes}</Row>
        <Row label="Anti-aliased px">{formatNumber(result.antialiasedPixels)}</Row>
        <Row label="Ignored px">{formatNumber(result.ignoredPixels)}</Row>
        <Row label="Specks dropped">
          {result.specks.count} ({formatNumber(result.specks.pixels)} px)
        </Row>
        <Row label="Compared at">
          {result.width}×{result.height}
        </Row>
        <Provenance snapshot={snapshot} />
      </dl>
      <SizeLine snapshot={snapshot} />
    </section>
  );
}

/** Where the shot was taken. The colour scheme is the capture's media query, not a theme. */
function Environment({ snapshot }: { snapshot: SnapshotView }) {
  return (
    <section>
      <Heading>Captured in</Heading>
      <dl className="space-y-1 text-sm">
        <Row label="Platform">{snapshot.platform}</Row>
        <Row label="Browser">{snapshot.browser}</Row>
        <Row label="Viewport">{snapshot.viewport}</Row>
        <Row label="Colour scheme">
          <span data-testid="color-scheme" className="font-mono text-xs">
            prefers-color-scheme: {snapshot.theme}
          </span>
        </Row>
      </dl>
    </section>
  );
}

/** Where a value came from, in the words the ticket asked for (ob 1495). */
function sourceText(source: OptionSource | undefined, config: number | undefined): string | null {
  if (!source) return null;
  if (source.from === "config") return "set in the config";
  const scope = source.scope === "variant" ? "this test, this variant" : "this test";
  const was = config === undefined ? "engine default" : String(config);
  return `set in the UI by @${source.by} on ${formatDateTime(new Date(source.at))} (${scope}); config says ${was}`;
}

/**
 * The options the diff ran with, and the source of each: one line when every one is the engine's
 * default. A server-measured shot carries what it was measured with (overrides included); a CI
 * shot only the config's.
 */
function Options({ snapshot, options }: { snapshot: SnapshotView; options: DiffOptions }) {
  const resolved = snapshot.resolvedDiff;
  const used = resolved?.options ?? options;
  const sourceOf = (key: keyof DiffOptions) => {
    if (resolved) return sourceText(resolved.sources[key], options[key]);
    return used[key] === undefined ? null : "set in the config";
  };
  const allDefault = OPTION_KEYS.every((key) => used[key] === undefined);
  const list = (
    <dl data-testid="diff-options" className="space-y-1 text-sm">
      {OPTION_KEYS.map((key) => {
        const source = sourceOf(key);
        return (
          <div key={key}>
            <Row label={key}>
              <span data-testid={`option-${key}`}>{used[key] ?? "engine default"}</span>
            </Row>
            {source && (
              <p data-testid={`source-${key}`} className="text-xs text-slate-500">
                {source}
              </p>
            )}
          </div>
        );
      })}
    </dl>
  );
  return (
    <section>
      <Heading>Diff options</Heading>
      {allDefault ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600">All engine defaults</summary>
          <div className="mt-2">{list}</div>
        </details>
      ) : (
        list
      )}
      <p className="mt-2 text-sm text-slate-600">
        {snapshot.ignore.length === 0
          ? "No ignore areas: every pixel was measured."
          : `${snapshot.ignore.length} ignore area${snapshot.ignore.length === 1 ? "" : "s"} skipped.`}
      </p>
    </section>
  );
}

/** The shot card's rule: a shot still awaiting a decision reads as carried, never as approved earlier. */
const approvedNow = (snapshot: SnapshotView) =>
  snapshot.approvedEarlier !== null && !awaitsDecision(snapshot);

/**
 * An unchanged shot that carries the branch's open change (ob 1712): it was compared with the
 * branch's previous shot, which holds the change; a decision here is a decision there too.
 */
function Carried({ projectId, snapshot }: { projectId: string; snapshot: SnapshotView }) {
  // A carried change that was accepted since reads as approved earlier instead (ob 1722).
  if (!snapshot.carriedFrom || approvedNow(snapshot)) return null;
  return (
    <section data-testid="carried">
      <Heading>Carried change</Heading>
      <p className="text-sm text-slate-700">
        No change since the branch's last build, whose change against the accepted baseline is still
        open. Accepting or rejecting here decides it on both builds.
      </p>
      {snapshot.carriedFromBuild && (
        <Link
          to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
          params={{
            projectId,
            buildId: snapshot.carriedFromBuild,
            snapshotId: snapshot.carriedFrom,
          }}
          className="mt-1 inline-block text-sm text-violet-700 underline"
        >
          See the change
        </Link>
      )}
    </section>
  );
}

/**
 * An unchanged shot whose change from the default branch was accepted on an earlier build of the
 * branch (ob 1722): the diff here is against that shot, so the change itself is shown there.
 */
function ApprovedEarlier({ projectId, snapshot }: { projectId: string; snapshot: SnapshotView }) {
  const approved = snapshot.approvedEarlier;
  if (!approved || !approvedNow(snapshot)) return null;
  return (
    <section data-testid="approved-earlier">
      <Heading>Approved earlier</Heading>
      <p className="text-sm text-slate-700">
        Approved on build{" "}
        <span className="font-mono text-xs">{approved.commitSha.slice(0, 7)}</span>
        {approved.reviewedBy && <> by {approved.reviewedBy}</>}
        {approved.reviewedAt && <>, {formatDateTime(approved.reviewedAt)}</>}. No change since, but
        this shot still differs from {approved.defaultBranch}.
      </p>
      <Link
        to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
        params={{ projectId, buildId: approved.buildId, snapshotId: approved.snapshotId }}
        className="mt-1 inline-block text-sm text-violet-700 underline"
        data-testid="approved-earlier-link"
      >
        See the change against {approved.defaultBranch}
      </Link>
    </section>
  );
}

export function SidePanel({
  projectId,
  snapshot,
  options,
  reviewable,
  status,
  after,
  children,
}: {
  projectId: string;
  snapshot: SnapshotView;
  options: DiffOptions;
  reviewable: boolean;
  status: string;
  /** Below the options: the override form, which edits them (ob 1495), and the ignore boxes (ob 1499). */
  after?: ReactNode;
  /** The detection flags and the flake, first: a second reviewer reads them before deciding. */
  children?: ReactNode;
}) {
  return (
    <aside className="space-y-6 border-slate-200 bg-white p-4 lg:border-l">
      {!reviewable && (
        <p className="text-sm text-slate-600">
          This build is {status}; a new build is needed to review it.
        </p>
      )}
      {children}
      <Carried projectId={projectId} snapshot={snapshot} />
      <ApprovedEarlier projectId={projectId} snapshot={snapshot} />
      <AiExplanation snapshot={snapshot} />
      <Measured snapshot={snapshot} />
      <Environment snapshot={snapshot} />
      <Options snapshot={snapshot} options={options} />
      {after}
    </aside>
  );
}
