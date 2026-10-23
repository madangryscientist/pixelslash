import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@hackcove/ui";
import { useHydrated } from "#/components/ui";
import type { BuildView, SnapshotView } from "#/db/review";
import { tabCounts } from "#/lib/build-tabs";
import { formatDateTime } from "#/lib/format";
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
    <p data-testid="summary-text">
      {build.aiSummary?.sentences.map((sentence, i) => (
        <span key={i} className="mb-1 block" data-testid="summary-sentence">
          {sentence.text}{" "}
          {sentence.shots.flatMap((id, _, ids) => {
            const shot = byId.get(id);
            if (!shot) return [];
            return [
              <Link
                key={id}
                to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                params={{ projectId, buildId: build.id, snapshotId: id }}
                className="mr-1 rounded border border-slate-200 px-1 text-xs text-violet-700 hover:underline"
                data-testid="summary-shot-link"
              >
                {linkText(shot, label(shot.name), oneStory(ids, byId))}
              </Link>,
            ];
          })}{" "}
        </span>
      ))}
    </p>
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
    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
      {summary && (
        <span data-testid="summary-model">
          {summary.model} · {formatDateTime(new Date(summary.at))}
        </span>
      )}
      {canRegenerate && (
        <Button
          variant="outline"
          disabled={!hydrated || busy}
          onClick={regenerate}
          className="px-2 py-1 text-xs"
          data-testid="summary-regenerate"
        >
          {busy ? "Regenerating…" : "Regenerate"}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      )}
    </div>
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
}: {
  projectId: string;
  build: Build;
  snapshots: SnapshotView[];
  modelConfigured: boolean;
}) {
  // A build still measuring, or one that stopped, has no verdict to summarise: what it held
  // before is not shown, and the run that finishes it writes the summary again.
  if (!VERDICTS.has(build.status)) return null;
  const describable = snapshots.some((shot) => DESCRIBED.has(shot.diffStatus ?? ""));
  return (
    <section
      className="mt-4 border-t border-slate-200 pt-4 text-sm text-slate-700"
      data-testid="build-summary"
    >
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        AI summary
      </h2>
      {build.aiSummary ? (
        <Sentences projectId={projectId} build={build} snapshots={snapshots} />
      ) : (
        describable && (
          <p className="text-slate-600" data-testid="summary-skip">
            skip: no judge.
          </p>
        )
      )}
      <p className="mt-1 text-slate-600" data-testid="summary-counts">
        {describable ? "" : "Nothing changed. "}
        {measuredCounts(snapshots).join(" · ")}.
      </p>
      <Footer projectId={projectId} build={build} canRegenerate={modelConfigured && describable} />
    </section>
  );
}
