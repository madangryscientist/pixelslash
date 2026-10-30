import {
  Caption,
  Disclosure,
  KeyValue,
  KeyValueList,
  Overline,
  Stack,
  TextLink,
  Text,
} from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IDENTICAL_NOTE } from "../../../../packages/engine/src/identical-note.ts";
import { AiExplanation } from "#/components/ai-notes";
import { Options } from "#/components/diff-options-list";
import { Provenance } from "#/components/provenance";
import type { SnapshotView } from "#/db/review";
import type { DiffOptions } from "#/db/schema";
import { formatDateTime, formatNumber } from "#/lib/format";
import { awaitsDecision } from "#/lib/snapshot-groups";

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
    <Text as="p" data-testid="sizes" tone="muted">
      {line}
    </Text>
  );
}

/**
 * The top of the panel: what the diff measured, or that it measured nothing (an unmeasured shot is
 * never "0 changed"). The size line is here whenever the sizes differ, so the overlap note is never
 * behind a disclosure (invariant 1).
 */
function Summary({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  let body: ReactNode;
  if (!result) {
    body = (
      <>
        <Text strong as="p">
          Not measured
        </Text>
        {snapshot.diffError && (
          <Text as="p" data-testid="diff-error" tone="danger">
            {snapshot.diffError}
          </Text>
        )}
      </>
    );
  } else if (result.settledBy) {
    body = (
      <Text strong as="p">
        Not measured: identical bytes
      </Text>
    );
  } else {
    const boxes = result.regions.filter((region) => region.kind === "change").length;
    body = (
      <KeyValueList>
        <KeyValue label="Changed px">{formatNumber(result.changedPixels)}</KeyValue>
        <KeyValue label="Changed regions">{boxes}</KeyValue>
      </KeyValueList>
    );
  }
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Measured
      </Overline>
      {body}
      {topSize(snapshot) && <SizeLine snapshot={snapshot} />}
    </Stack>
  );
}

/** The size line sits in the summary unless it only restates matching sizes of a measured diff. */
const topSize = (snapshot: SnapshotView) => {
  const result = snapshot.diffResult;
  return !result || result.sizeChanged || Boolean(result.settledBy);
};

/** The rest of what the diff measured, and who measured it: in Details. */
function MeasuredDetails({ snapshot }: { snapshot: SnapshotView }) {
  const result = snapshot.diffResult;
  const counts = result && !result.settledBy;
  if (!counts && !snapshot.measuredBy) return null;
  return (
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Measured
      </Overline>
      <KeyValueList>
        {counts && (
          <>
            <KeyValue label="Anti-aliased px">{formatNumber(result.antialiasedPixels)}</KeyValue>
            <KeyValue label="Ignored px">{formatNumber(result.ignoredPixels)}</KeyValue>
            <KeyValue label="Specks dropped">
              {result.specks.count} ({formatNumber(result.specks.pixels)} px)
            </KeyValue>
            <KeyValue label="Compared at">{`${result.width}×${result.height}`}</KeyValue>
          </>
        )}
        <Provenance snapshot={snapshot} />
      </KeyValueList>
      {!topSize(snapshot) && <SizeLine snapshot={snapshot} />}
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
      <Text as="p">
        No change since the branch's last build, whose change against the accepted baseline is still
        open. Accepting or rejecting here decides it on both builds.
      </Text>
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
      <Text as="p">
        Approved on build <Caption mono>{approved.commitSha.slice(0, 7)}</Caption>
        {approved.reviewedBy && <> by {approved.reviewedBy}</>}
        {approved.reviewedAt && <>, {formatDateTime(approved.reviewedAt)}</>}. No change since, but
        this shot still differs from {approved.defaultBranch}.
      </Text>
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
  tools,
  children,
}: {
  projectId: string;
  snapshot: SnapshotView;
  options: DiffOptions;
  reviewable: boolean;
  status: string;
  /** Re-run, mark flaky, thresholds and ignore areas: collapsed under Tools; null when none apply. */
  tools?: ReactNode;
  /** The detection flags and an open flake, above the fold: a second reviewer reads them before deciding. */
  children?: ReactNode;
}) {
  return (
    <Stack gap="md">
      {!reviewable && (
        <Text as="p" tone="muted">
          This build is {status}; a new build is needed to review it.
        </Text>
      )}
      <AiExplanation snapshot={snapshot} />
      <Summary snapshot={snapshot} />
      <Carried projectId={projectId} snapshot={snapshot} />
      <ApprovedEarlier projectId={projectId} snapshot={snapshot} />
      {children}
      <Stack gap="xs">
        <Disclosure
          summary={
            <Text strong as="span">
              Details
            </Text>
          }
        >
          <Stack gap="md">
            <MeasuredDetails snapshot={snapshot} />
            <Environment snapshot={snapshot} />
            <Options snapshot={snapshot} options={options} />
          </Stack>
        </Disclosure>
        {tools && (
          <Disclosure
            summary={
              <Text strong as="span">
                Tools
              </Text>
            }
          >
            <Stack gap="md">{tools}</Stack>
          </Disclosure>
        )}
      </Stack>
    </Stack>
  );
}
