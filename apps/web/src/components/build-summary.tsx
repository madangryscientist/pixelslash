import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Body, Button, Caption, Cluster, Divider, Overline, Pill, Stack } from "@hackcove/ui";
import { useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { tabCounts } from "#/lib/build-tabs";
import { formatDateTime } from "#/lib/format";
import { noSummaryReason, tooManyChanges } from "#/lib/summary-limit";
import { type ShotLabel, shotChips, shotLabeller } from "#/lib/shot-label";
import { regenerateBuildSummary } from "#/server/model";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the page states from the measurements, beside the model's sentences: the model is never
 * asked about these, so a shot that was not measured is never read as unchanged.
 */
function measuredCounts(snapshots: SnapshotView[]): string[] {
  const counts = tabCounts(snapshots);
  const noise = snapshots
    .flatMap((shot) => shot.aiReview?.regions ?? [])
    .filter((note) => note.label === "noise").length;
  const parts = [`${counts.unchanged} unchanged`];
  if (counts.unmeasured > 0)
    parts.push(
      `${plural(counts.unmeasured, "shot")} not measured: not compared, so not known to be unchanged`,
    );
  if (noise > 0) parts.push(`${plural(noise, "region")} labelled likely noise`);
  return parts;
}

const story = (name: string) => name.split("@")[0] ?? name;

/** The sentence's shots are variants of one story: a link names only the variant. */
function oneStory(ids: string[], byId: Map<string, SnapshotView>): boolean {
  return new Set(ids.map((id) => story(byId.get(id)?.name ?? id))).size === 1;
}

function linkText(shot: SnapshotView, label: ShotLabel, variantOnly: boolean): string {
  const variant = shotChips(shot, label)[0] ?? shot.viewport;
  return variantOnly ? variant : `${label.story} · ${variant}`;
}

type Build = BuildView["build"];

/** The stored sentences, each followed by links to the shots it names. */
function Sentences({
  projectId,
  build,
  snapshots,
}: {
  projectId: string;
  build: Build;
  snapshots: SnapshotView[];
}) {
  const label = shotLabeller(snapshots.map((shot) => shot.name));
  const byId = new Map(snapshots.map((shot) => [shot.id, shot]));
  return (
    <Stack gap="xs" data-testid="summary-text">
      {build.aiSummary?.sentences.map((sentence, i) => (
        <Body as="p" key={i} data-testid="summary-sentence">
          {sentence.text}{" "}
          {sentence.shots.flatMap((id, _, ids) => {
            const shot = byId.get(id);
            if (!shot) return [];
            return [
              <Pill
                key={id}
                tone="violet"
                data-testid="summary-shot-link"
                render={(props) => (
                  <Link
                    to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                    params={{ projectId, buildId: build.id, snapshotId: id }}
                    {...props}
                  />
                )}
              >
                {linkText(shot, label(shot.name), oneStory(ids, byId))}
              </Pill>,
              " ",
            ];
          })}
        </Body>
      ))}
    </Stack>
  );
}

/** Which model wrote it and when, and the Regenerate action when there is something to ask. */
function Footer({
  projectId,
  build,
  canRegenerate,
}: {
  projectId: string;
  build: Build;
  canRegenerate: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = build.aiSummary;
  if (!summary && !canRegenerate) return null;
  const regenerate = () => {
    setBusy(true);
    setError(null);
    void regenerateBuildSummary({ data: { projectId, buildId: build.id } })
      .then(async ({ stored }) => {
        if (!stored) setError("The model made no summary; see the Worker log.");
        await router.invalidate();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Cluster gap="sm" wrap>
      {summary && (
        <Caption data-testid="summary-model">
          {summary.model} · {formatDateTime(new Date(summary.at))}
        </Caption>
      )}
      {canRegenerate && (
        <Button
          variant="outline"
          disabled={!hydrated || busy}
          onClick={regenerate}
          size="sm"
          data-testid="summary-regenerate"
        >
          {busy ? "Regenerating…" : "Regenerate"}
        </Button>
      )}
      {error && (
        <Caption role="alert" tone="danger">
          {error}
        </Caption>
      )}
    </Cluster>
  );
}

/** The sentences, the reason there are none, or "skip: no judge" when a model made none. */
function SummaryBody({
  projectId,
  build,
  snapshots,
  changed,
  modelConfigured,
  describable,
  pending,
}: {
  projectId: string;
  build: Build;
  snapshots: SnapshotView[];
  changed: number;
  modelConfigured: boolean;
  describable: boolean;
  pending: boolean;
}) {
  // A summary stored before the limit existed is still true of its build, so it stays.
  if (build.aiSummary)
    return <Sentences projectId={projectId} build={build} snapshots={snapshots} />;
  if (!describable) return null;
  if (modelConfigured && tooManyChanges(changed))
    return (
      <Body as="p" tone="muted" data-testid="summary-too-many">
        {noSummaryReason(changed)}
      </Body>
    );
  // Written once every shot is explained (ob 1875); a big build gets none.
  if (pending)
    return (
      <Body as="p" tone="muted" data-testid="summary-pending">
        explaining…
      </Body>
    );
  return (
    <Body as="p" tone="muted" data-testid="summary-skip">
      skip: no judge.
    </Body>
  );
}

const DESCRIBED = new Set(["changed", "new", "removed"]);
const VERDICTS = new Set(["changes", "passed", "failed"]);

/**
 * The build's AI summary (ob 1668), at the top of the build page: the project model's sentences,
 * each linking to the shots it describes, or "skip: no judge" when none was made. Text for the
 * reviewer; it changes no verdict and no review.
 */
export function BuildSummary({
  projectId,
  build,
  snapshots,
  modelConfigured,
  pending,
}: {
  projectId: string;
  build: Build;
  snapshots: SnapshotView[];
  modelConfigured: boolean;
  /** The summary waits on its shots' explanations. */
  pending: boolean;
}) {
  // A build still measuring, or one that stopped, has no verdict to summarise: what it held
  // before is not shown, and the run that finishes it writes the summary again.
  if (!VERDICTS.has(build.status)) return null;
  const describable = snapshots.some((shot) => DESCRIBED.has(shot.diffStatus ?? ""));
  const changed = snapshots.filter((shot) => shot.diffStatus === "changed").length;
  return (
    <Stack as="section" gap="xs" data-testid="build-summary">
      <Divider />
      <Overline as="h2">AI summary</Overline>
      <SummaryBody
        projectId={projectId}
        build={build}
        snapshots={snapshots}
        changed={changed}
        modelConfigured={modelConfigured}
        describable={describable}
        pending={pending}
      />
      <Body as="p" tone="muted" data-testid="summary-counts">
        {describable ? "" : "Nothing changed. "}
        {measuredCounts(snapshots).join(" · ")}.
      </Body>
      <Footer
        projectId={projectId}
        build={build}
        // While the queue writes it, a Regenerate would summarise notes not all in yet.
        canRegenerate={modelConfigured && describable && !tooManyChanges(changed) && !pending}
      />
    </Stack>
  );
}
