import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Caption, Cluster, Divider, Overline, Pill, Stack, Text } from "@hackcove/ui";
import { useHydrated } from "#/components/ui";
import type { AiSummarySentence } from "#/db/diff-json";
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

/** One stored sentence, followed by links to the shots it names. */
function Sentence({
  projectId,
  buildId,
  sentence,
  byId,
  label,
  testId,
  lead,
}: {
  projectId: string;
  buildId: string;
  sentence: AiSummarySentence;
  byId: Map<string, SnapshotView>;
  label: (name: string) => ShotLabel;
  testId: string;
  lead?: string;
}) {
  return (
    <Text as="p" data-testid={testId}>
      {lead && <Text strong>{lead} </Text>}
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
                params={{ projectId, buildId, snapshotId: id }}
                {...props}
              />
            )}
          >
            {linkText(shot, label(shot.name), oneStory(ids, byId))}
          </Pill>,
          " ",
        ];
      })}
    </Text>
  );
}

/**
 * The stored sentences, then, for a summary read against the uploader's brief (PS-232), the
 * model's sentence on whether the changes match it: the model's read, never a verdict.
 */
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
  const summary = build.aiSummary;
  const shared = { projectId, buildId: build.id, byId, label };
  return (
    <Stack gap="xs" data-testid="summary-text">
      {summary?.sentences.map((sentence, i) => (
        <Sentence key={i} {...shared} sentence={sentence} testId="summary-sentence" />
      ))}
      {summary?.match && (
        <Sentence
          {...shared}
          sentence={summary.match}
          testId="summary-match"
          lead="Against the brief:"
        />
      )}
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
          {summary.match && " · read against the brief"}
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
      <Text as="p" tone="muted" data-testid="summary-too-many">
        {noSummaryReason(changed)}
      </Text>
    );
  // Written once every shot is explained (ob 1875); a big build gets none.
  if (pending)
    return (
      <Text as="p" tone="muted" data-testid="summary-pending">
        explaining…
      </Text>
    );
  return (
    <Text as="p" tone="muted" data-testid="summary-skip">
      skip: no judge.
    </Text>
  );
}

/** With a brief, nothing changed is still not a match: there was nothing to read against it. */
const nothingChanged = (brief: string | null) =>
  brief ? "Nothing changed, so there is nothing to read against the brief. " : "Nothing changed. ";

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
      <Text as="p" tone="muted" data-testid="summary-counts">
        {describable ? "" : nothingChanged(build.brief)}
        {measuredCounts(snapshots).join(" · ")}.
      </Text>
      <Footer
        projectId={projectId}
        build={build}
        // While the queue writes it, a Regenerate would summarise notes not all in yet.
        canRegenerate={modelConfigured && describable && !tooManyChanges(changed) && !pending}
      />
    </Stack>
  );
}
