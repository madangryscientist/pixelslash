import {
  Body,
  Button,
  ButtonGroup,
  Caption,
  Card,
  Cluster,
  CopyLine,
  Input,
  Overline,
  Pill,
  Radio,
  RadioGroup,
  Stack,
} from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { useFlagWrite } from "#/components/detection-flag";
import { useHydrated } from "#/components/ui";
import type { FlakyPolicy } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { type FlakeView, markShotFlaky } from "#/server/flakes";

/**
 * Flakes on the page (ob 1724). The policy is the shot's own config (`"flaky"` on a route, a
 * `pixelslash-flaky-*` tag on a story); the server only reads what an upload sent, so the policy
 * control here copies a config line and changes nothing on the server.
 */

/** The `flakes` list's anchor for one flake. */
export const flakeAnchor = (flakeId: string) => `flake-${flakeId}`;

/** "flaky", or "skipped: flaky" when its `skip` policy let the build pass by it; links to the flake. */
export function FlakyBadge({
  projectId,
  flakeId,
  skipped,
}: {
  projectId: string;
  flakeId: string;
  skipped: boolean;
}) {
  return (
    <Pill
      tone="amber"
      data-testid="flaky-badge"
      render={(props) => (
        <Link
          to="/projects/$projectId/flakes"
          params={{ projectId }}
          hash={flakeAnchor(flakeId)}
          {...props}
        />
      )}
    >
      {skipped ? "skipped: flaky" : "flaky"}
    </Pill>
  );
}

const POLICY_TEXT: Record<FlakyPolicy, string> = {
  review: "review: it waits for a decision and blocks the build like any change.",
  skip: "skip: it does not wait or block, is never accepted, and its baseline does not move.",
};

const other = (policy: FlakyPolicy): FlakyPolicy => (policy === "skip" ? "review" : "skip");

/**
 * What to paste to change a shot's policy: a route's `"flaky"` field or a story's tag. Nothing is
 * stored here; the next build's upload carries the new policy.
 */
export function FlakyPolicyControl({ policy }: { policy: FlakyPolicy }) {
  const [target, setTarget] = useState<FlakyPolicy>(other(policy));
  const hydrated = useHydrated();
  return (
    <Stack gap="xs" data-testid="flaky-policy-control">
      <RadioGroup
        name="flaky-target"
        label="Set the policy to"
        value={target}
        onChange={(value) => {
          if (value === "skip" || value === "review") setTarget(value);
        }}
      >
        {(["skip", "review"] as const).map((option) => (
          <Radio key={option} value={option} label={option} />
        ))}
      </RadioGroup>
      <Caption as="p">A route in your capture config:</Caption>
      <CopyLine text={`"flaky": "${target}"`} disabled={!hydrated} data-testid="flaky-route-line" />
      <Caption as="p">Or a story's tag:</Caption>
      <CopyLine
        text={`pixelslash-flaky-${target}`}
        disabled={!hydrated}
        data-testid="flaky-story-tag"
      />
      <Caption as="p">It takes effect from the next build. Nothing changes on the server.</Caption>
    </Stack>
  );
}

/** One build's runs side by side: run 1 is the shot, a run that differed from it is outlined. */
export function FlakeRuns({ evidence }: { evidence: FlakeView["evidence"][number] }) {
  return (
    <Stack gap="xs">
      <Body as="p" data-testid="flake-differed">
        {evidence.differed.length} of {evidence.runs} runs differed (run
        {evidence.differed.length === 1 ? "" : "s"} {evidence.differed.join(", ")})
      </Body>
      <ul className="grid grid-cols-3 gap-2">
        {evidence.images.map((image) => {
          const differed = evidence.differed.includes(image.run);
          return (
            <li key={image.run} data-testid="flake-run" data-differed={differed}>
              <a href={image.url} target="_blank" rel="noreferrer" className="block">
                <img
                  src={image.url}
                  alt={`Run ${image.run}`}
                  loading="lazy"
                  className={`aspect-[3/2] w-full rounded border object-cover object-top ${
                    differed ? "border-2 border-amber-500" : "border-slate-200"
                  }`}
                />
              </a>
              <Caption>
                run {image.run}
                {differed ? " · differed" : ""}
              </Caption>
            </li>
          );
        })}
      </ul>
    </Stack>
  );
}

/** Who marked it by hand, and how it was resolved: the history beside the evidence. */
export function FlakeHistory({ flake }: { flake: FlakeView }) {
  const resolved = flake.status === "resolved";
  if (!flake.createdBy && !resolved) return null;
  return (
    <Stack as="ul" gap="xs">
      {flake.createdBy && (
        <Body as="li">
          Marked flaky by {flake.createdBy}
          {flake.note && <>: {flake.note}</>}
        </Body>
      )}
      {resolved && (
        <Body as="li" data-testid="flake-resolution">
          Resolved{flake.resolvedBy && <> by {flake.resolvedBy}</>}
          {flake.resolvedAt && <>, {formatDateTime(flake.resolvedAt)}</>}
          {flake.resolutionNote && <>: {flake.resolutionNote}</>}
        </Body>
      )}
    </Stack>
  );
}

function MarkFlakyForm({
  projectId,
  snapshotId,
  onClose,
}: {
  projectId: string;
  snapshotId: string;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const { busy, error, run } = useFlagWrite(onClose);
  const save = (event: FormEvent) => {
    event.preventDefault();
    run(() => markShotFlaky({ data: { projectId, snapshotId, note } }));
  };
  return (
    <Card tone="warn" size="sm">
      <Stack as="form" gap="sm" onSubmit={save} aria-label="Mark flaky">
        <Body as="p">
          Opens a flake for this shot's name and variant. Its config's policy then applies; with
          none, it is review.
        </Body>
        <Input
          aria-label="Note (optional)"
          placeholder="Note (optional)"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <Body as="p" role="alert" tone="danger">
            {error}
          </Body>
        )}
        <ButtonGroup>
          <Button type="submit" busy={busy} busyLabel="Marking…" size="sm">
            Mark flaky
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
        </ButtonGroup>
      </Stack>
    </Card>
  );
}

/**
 * The side panel's flake section: the badge, this build's runs side by side, the policy in effect
 * and how to change it; on a shot with no flake, the control to mark it flaky by hand.
 */
export function FlakePanel({
  projectId,
  snapshot,
  flake,
  skipped,
}: {
  projectId: string;
  snapshot: { id: string; flakyPolicy: FlakyPolicy | null };
  flake: FlakeView | null;
  skipped: boolean;
}) {
  const hydrated = useHydrated();
  const [marking, setMarking] = useState(false);
  if (!flake) {
    return (
      <section data-testid="flake-panel">
        {marking ? (
          <MarkFlakyForm
            projectId={projectId}
            snapshotId={snapshot.id}
            onClose={() => setMarking(false)}
          />
        ) : (
          <Button variant="outline" disabled={!hydrated} onClick={() => setMarking(true)} size="sm">
            Mark flaky
          </Button>
        )}
      </section>
    );
  }
  const policy = snapshot.flakyPolicy ?? "review";
  // This build's evidence if it sent any; else the latest from another build.
  const evidence =
    flake.evidence.find((e) => e.snapshotId === snapshot.id) ?? flake.evidence.at(-1);
  return (
    <Stack as="section" gap="sm" data-testid="flake-panel">
      <Overline as="h2">Flaky</Overline>
      <Cluster gap="xs" wrap>
        <FlakyBadge projectId={projectId} flakeId={flake.id} skipped={skipped} />
        <Body tone="muted">{flake.status}</Body>
      </Cluster>
      {evidence ? (
        <>
          {evidence.snapshotId !== snapshot.id && (
            <Caption as="p">Not re-captured in this build; the latest detection:</Caption>
          )}
          <FlakeRuns evidence={evidence} />
        </>
      ) : (
        <Body as="p" tone="muted">
          No re-captures: marked by hand.
        </Body>
      )}
      <FlakeHistory flake={flake} />
      <Body as="p" data-testid="flaky-policy">
        Policy in effect: {POLICY_TEXT[policy]}
        {snapshot.flakyPolicy === null && " (none sent; review is the default)"}
      </Body>
      <FlakyPolicyControl policy={policy} />
    </Stack>
  );
}
