import { Button, Input, Pill } from "@hackcove/ui";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { ActionButton } from "#/components/action-button";
import { CopyLine } from "#/components/copy-button";
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
    <Link
      to="/projects/$projectId/flakes"
      params={{ projectId }}
      hash={flakeAnchor(flakeId)}
      data-testid="flaky-badge"
      className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-violet-600"
    >
      <Pill tone="amber">{skipped ? "skipped: flaky" : "flaky"}</Pill>
    </Link>
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
  const hydrated = useHydrated();
  const [target, setTarget] = useState<FlakyPolicy>(other(policy));
  return (
    <div data-testid="flaky-policy-control" className="space-y-2 text-sm">
      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="sr-only">Policy to switch to</legend>
        <span className="text-slate-600">Set the policy to</span>
        {(["skip", "review"] as const).map((option) => (
          <label key={option} className="flex items-center gap-1">
            <input
              type="radio"
              name="flaky-target"
              value={option}
              checked={target === option}
              onChange={() => setTarget(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <p className="text-xs text-slate-500">A route in your capture config:</p>
      <CopyLine text={`"flaky": "${target}"`} hydrated={hydrated} testId="flaky-route-line" />
      <p className="text-xs text-slate-500">Or a story's tag:</p>
      <CopyLine text={`pixelslash-flaky-${target}`} hydrated={hydrated} testId="flaky-story-tag" />
      <p className="text-xs text-slate-500">
        It takes effect from the next build. Nothing changes on the server.
      </p>
    </div>
  );
}

/** One build's runs side by side: run 1 is the shot, a run that differed from it is outlined. */
export function FlakeRuns({ evidence }: { evidence: FlakeView["evidence"][number] }) {
  return (
    <div>
      <p data-testid="flake-differed" className="text-sm text-slate-700">
        {evidence.differed.length} of {evidence.runs} runs differed (run
        {evidence.differed.length === 1 ? "" : "s"} {evidence.differed.join(", ")})
      </p>
      <ul className="mt-2 grid grid-cols-3 gap-2">
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
              <span className="text-xs text-slate-500">
                run {image.run}
                {differed ? " · differed" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Who marked it by hand, and how it was resolved: the history beside the evidence. */
export function FlakeHistory({ flake }: { flake: FlakeView }) {
  const resolved = flake.status === "resolved";
  if (!flake.createdBy && !resolved) return null;
  return (
    <ul className="space-y-1 text-sm text-slate-700">
      {flake.createdBy && (
        <li>
          Marked flaky by {flake.createdBy}
          {flake.note && <>: {flake.note}</>}
        </li>
      )}
      {resolved && (
        <li data-testid="flake-resolution">
          Resolved{flake.resolvedBy && <> by {flake.resolvedBy}</>}
          {flake.resolvedAt && <>, {formatDateTime(flake.resolvedAt)}</>}
          {flake.resolutionNote && <>: {flake.resolutionNote}</>}
        </li>
      )}
    </ul>
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
    <form
      onSubmit={save}
      aria-label="Mark flaky"
      className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3 text-sm"
    >
      <p className="text-slate-700">
        Opens a flake for this shot's name and variant. Its config's policy then applies; with none,
        it is review.
      </p>
      <Input
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <ActionButton type="submit" busy={busy} busyLabel="Marking…" className="px-3 py-1.5">
          Mark flaky
        </ActionButton>
        <Button type="button" variant="ghost" onClick={onClose} className="px-3 py-1.5">
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
      {children}
    </h2>
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
          <Button
            variant="outline"
            disabled={!hydrated}
            onClick={() => setMarking(true)}
            className="px-3 py-1.5"
          >
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
    <section data-testid="flake-panel" className="space-y-3">
      <Heading>Flaky</Heading>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FlakyBadge projectId={projectId} flakeId={flake.id} skipped={skipped} />
        <span className="text-slate-600">{flake.status}</span>
      </div>
      {evidence ? (
        <>
          {evidence.snapshotId !== snapshot.id && (
            <p className="text-xs text-slate-500">
              Not re-captured in this build; the latest detection:
            </p>
          )}
          <FlakeRuns evidence={evidence} />
        </>
      ) : (
        <p className="text-sm text-slate-600">No re-captures: marked by hand.</p>
      )}
      <FlakeHistory flake={flake} />
      <p data-testid="flaky-policy" className="text-sm text-slate-700">
        Policy in effect: {POLICY_TEXT[policy]}
        {snapshot.flakyPolicy === null && " (none sent; review is the default)"}
      </p>
      <FlakyPolicyControl policy={policy} />
    </section>
  );
}
