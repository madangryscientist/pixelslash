import type { ReactNode } from "react";
import type { SnapshotView } from "#/db/review";
import type { DiffOptions } from "#/db/schema";
import { formatNumber } from "#/lib/format";

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

/** What the diff measured, or that it measured nothing: an unmeasured shot is never "0 changed". */
function Measured({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  if (!result) {
    return (
      <section>
        <Heading>Measured</Heading>
        <p className="text-sm font-medium">Not measured</p>
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

/** The options the diff ran with: one line when every one is the engine's default. */
function Options({ snapshot, options }: { snapshot: SnapshotView; options: DiffOptions }) {
  const allDefault = OPTION_KEYS.every((key) => options[key] === undefined);
  const list = (
    <dl data-testid="diff-options" className="space-y-1 text-sm">
      {OPTION_KEYS.map((key) => (
        <Row key={key} label={key}>
          {options[key] ?? "engine default"}
        </Row>
      ))}
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

export function SidePanel({
  snapshot,
  options,
  reviewable,
  status,
}: {
  snapshot: SnapshotView;
  options: DiffOptions;
  reviewable: boolean;
  status: string;
}) {
  return (
    <aside className="space-y-6 border-slate-200 bg-white p-4 lg:border-l">
      {!reviewable && (
        <p className="text-sm text-slate-600">
          This build is {status}; a new build is needed to review it.
        </p>
      )}
      <Measured snapshot={snapshot} />
      <Environment snapshot={snapshot} />
      <Options snapshot={snapshot} options={options} />
    </aside>
  );
}
