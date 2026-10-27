import {
  Body,
  BodyStrong,
  Caption,
  Disclosure,
  KeyValue,
  KeyValueList,
  Overline,
  Stack,
  TextLink,
} from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IDENTICAL_NOTE } from "../../../../packages/engine/src/identical-note.ts";
import { AiExplanation } from "#/components/ai-notes";
import { Provenance } from "#/components/provenance";
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

function sizeLine(result: NonNullable<SnapshotView["diffResult"]>, main: string, branch: string) {
  if (result.settledBy) return `${IDENTICAL_NOTE}; both shots are ${main}.`;
  if (!result.sizeChanged)
    return `Both shots are ${main}; compared at ${result.width}×${result.height}.`;
  return `Main ${main} · Branch ${branch} · compared at ${result.width}×${result.height} (the overlap). The rest was not painted as changed.`;
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
    line = sizeLine(result, main, branch);
  }
  return (
    <Body as="p" data-testid="sizes" tone="muted">
      {line}
    </Body>
  );
}

/** What the diff measured, or that it measured nothing: an unmeasured shot is never "0 changed". */
function Measured({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  if (!result) {
    return (
      <Stack as="section" gap="xs">
        <Overline as="h2" tone="muted">
          Measured
        </Overline>
        <BodyStrong as="p">Not measured</BodyStrong>
        {snapshot.diffError && (
          <Body as="p" data-testid="diff-error" tone="danger">
            {snapshot.diffError}
          </Body>
        )}
        {snapshot.measuredBy && (
          <KeyValueList>
            <Provenance snapshot={snapshot} />
          </KeyValueList>
        )}
        <SizeLine snapshot={snapshot} />
      </Stack>
    );
  }
  if (result.settledBy) {
    return (
      <Stack as="section" gap="xs">
        <Overline as="h2" tone="muted">
          Measured
        </Overline>
        <BodyStrong as="p">Not measured: identical bytes</BodyStrong>
        <SizeLine snapshot={snapshot} />
      </Stack>
    );
  }
  const boxes = result.regions.filter((region) => region.kind === "change").length;
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Measured
      </Overline>
      <KeyValueList>
        <KeyValue label="Changed px">{formatNumber(result.changedPixels)}</KeyValue>
        <KeyValue label="Changed regions">{boxes}</KeyValue>
        <KeyValue label="Anti-aliased px">{formatNumber(result.antialiasedPixels)}</KeyValue>
        <KeyValue label="Ignored px">{formatNumber(result.ignoredPixels)}</KeyValue>
        <KeyValue label="Specks dropped">
          {result.specks.count} ({formatNumber(result.specks.pixels)} px)
        </KeyValue>
        <KeyValue label="Compared at">{`${result.width}×${result.height}`}</KeyValue>
        <Provenance snapshot={snapshot} />
      </KeyValueList>
      <SizeLine snapshot={snapshot} />
    </Stack>
  );
}

/** Where the shot was taken. The colour scheme is the capture's media query, not a theme. */
function Environment({ snapshot }: { snapshot: SnapshotView }) {
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Captured in
      </Overline>
      <KeyValueList>
        <KeyValue label="Platform">{snapshot.platform}</KeyValue>
        <KeyValue label="Browser">{snapshot.browser}</KeyValue>
        <KeyValue label="Viewport">{snapshot.viewport}</KeyValue>
        <KeyValue label="Colour scheme">
          <Caption data-testid="color-scheme" mono>
            prefers-color-scheme: {snapshot.theme}
          </Caption>
        </KeyValue>
      </KeyValueList>
    </Stack>
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
function ignoreLine(snapshot: SnapshotView): string {
  const n = snapshot.ignore.length;
  if (n > 0) return `${n} ignore area${n === 1 ? "" : "s"} skipped.`;
  return snapshot.diffResult?.settledBy
    ? "No ignore areas."
    : "No ignore areas: every pixel was measured.";
}

function Options({ snapshot, options }: { snapshot: SnapshotView; options: DiffOptions }) {
  const resolved = snapshot.resolvedDiff;
  const used = resolved?.options ?? options;
  const sourceOf = (key: keyof DiffOptions) => {
    if (resolved) return sourceText(resolved.sources[key], options[key]);
    return used[key] === undefined ? null : "set in the config";
  };
  const allDefault = OPTION_KEYS.every((key) => used[key] === undefined);
  const list = (
    <KeyValueList data-testid="diff-options">
      {OPTION_KEYS.map((key) => {
        const source = sourceOf(key);
        return (
          <div key={key}>
            <KeyValue label={key}>
              <span data-testid={`option-${key}`}>{used[key] ?? "engine default"}</span>
            </KeyValue>
            {source && (
              <Caption as="p" data-testid={`source-${key}`} tone="muted">
                {source}
              </Caption>
            )}
          </div>
        );
      })}
    </KeyValueList>
  );
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Diff options
      </Overline>
      {allDefault ? (
        <Disclosure
          summary={
            <Body as="span" tone="muted">
              All engine defaults
            </Body>
          }
        >
          {list}
        </Disclosure>
      ) : (
        list
      )}
      <Body as="p" tone="muted">
        {ignoreLine(snapshot)}
      </Body>
    </Stack>
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
  const { carriedFrom, carriedFromBuild } = snapshot;
  if (!carriedFrom || approvedNow(snapshot)) return null;
  return (
    <Stack as="section" gap="xs" data-testid="carried">
      <Overline as="h2" tone="muted">
        Carried change
      </Overline>
      <Body as="p">
        No change since the branch's last build, whose change against the accepted baseline is still
        open. Accepting or rejecting here decides it on both builds.
      </Body>
      {carriedFromBuild && (
        <TextLink
          render={(p) => (
            <Link
              to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
              params={{
                projectId,
                buildId: carriedFromBuild,
                snapshotId: carriedFrom,
              }}
              {...p}
            />
          )}
        >
          See the change
        </TextLink>
      )}
    </Stack>
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
    <Stack as="section" gap="xs" data-testid="approved-earlier">
      <Overline as="h2" tone="muted">
        Approved earlier
      </Overline>
      <Body as="p">
        Approved on build <Caption mono>{approved.commitSha.slice(0, 7)}</Caption>
        {approved.reviewedBy && <> by {approved.reviewedBy}</>}
        {approved.reviewedAt && <>, {formatDateTime(approved.reviewedAt)}</>}. No change since, but
        this shot still differs from {approved.defaultBranch}.
      </Body>
      <TextLink
        data-testid="approved-earlier-link"
        render={(p) => (
          <Link
            to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
            params={{ projectId, buildId: approved.buildId, snapshotId: approved.snapshotId }}
            {...p}
          />
        )}
      >
        See the change against {approved.defaultBranch}
      </TextLink>
    </Stack>
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
    <Stack gap="md">
      {!reviewable && (
        <Body as="p" tone="muted">
          This build is {status}; a new build is needed to review it.
        </Body>
      )}
      {children}
      <Carried projectId={projectId} snapshot={snapshot} />
      <ApprovedEarlier projectId={projectId} snapshot={snapshot} />
      <AiExplanation snapshot={snapshot} />
      <Measured snapshot={snapshot} />
      <Environment snapshot={snapshot} />
      <Options snapshot={snapshot} options={options} />
      {after}
    </Stack>
  );
}
