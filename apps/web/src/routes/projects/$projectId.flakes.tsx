import { Button, Input, Pill } from "@hackcove/ui";
import { Link, createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ActionButton } from "#/components/action-button";
import { orgCrumb, projectCrumb } from "#/components/crumbs";
import { useFlagWrite } from "#/components/detection-flag";
import { FlakeHistory, FlakeRuns, FlakyPolicyControl, flakeAnchor } from "#/components/flake";
import { Page, useHydrated } from "#/components/ui";
import { formatRelative } from "#/lib/format";
import { type FlakeView, getFlakesPage, saveFlakeStatus } from "#/server/flakes";

export const Route = createFileRoute("/projects/$projectId/flakes")({
  loader: ({ params }) => getFlakesPage({ data: { projectId: params.projectId } }),
  component: FlakesPage,
});

/** The flake's variant, as the build page names one: what is not the default reads as a chip. */
const variantOf = (flake: FlakeView) =>
  [flake.platform, flake.browser, flake.viewport, flake.theme].join(" · ");

/** Resolve with an optional note, or reopen a resolved flake. */
function StatusControl({ projectId, flake }: { projectId: string; flake: FlakeView }) {
  const hydrated = useHydrated();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const { busy, error, run } = useFlagWrite(() => setResolving(false));
  const ids = { projectId, flakeId: flake.id };
  const resolve = (event: FormEvent) => {
    event.preventDefault();
    run(() => saveFlakeStatus({ data: { ...ids, open: false, note } }));
  };
  if (flake.status === "resolved") {
    return (
      <div className="space-y-1">
        <ActionButton
          variant="outline"
          busy={busy}
          busyLabel="Reopening…"
          disabledReason={hydrated ? undefined : "Loading"}
          onClick={() => run(() => saveFlakeStatus({ data: { ...ids, open: true, note: null } }))}
          className="px-3 py-1.5"
        >
          Reopen
        </ActionButton>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    );
  }
  if (!resolving) {
    return (
      <Button
        variant="outline"
        disabled={!hydrated}
        onClick={() => setResolving(true)}
        className="px-3 py-1.5"
      >
        Resolve
      </Button>
    );
  }
  return (
    <form onSubmit={resolve} aria-label="Resolve flake" className="space-y-2 text-sm">
      <Input
        aria-label="Resolution note (optional)"
        placeholder="What fixed it (optional)"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        className="w-full px-3"
      />
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <ActionButton type="submit" busy={busy} busyLabel="Resolving…" className="px-3 py-1.5">
          Resolve
        </ActionButton>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setResolving(false)}
          className="px-3 py-1.5"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FlakeItem({ projectId, flake, now }: { projectId: string; flake: FlakeView; now: Date }) {
  const latest = flake.evidence.at(-1);
  // The policy the latest detection was captured under; a hand mark sent none, so review.
  const policy = latest?.policy ?? "review";
  return (
    <li
      id={flakeAnchor(flake.id)}
      data-testid="flake"
      data-status={flake.status}
      className="scroll-mt-6 space-y-3 rounded-xl border border-slate-200 bg-white p-5 target:border-violet-400"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium">
            <Pill tone={flake.status === "open" ? "amber" : "slate"}>{flake.status}</Pill>
            <span data-testid="flake-name" className="truncate">
              {flake.name}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {variantOf(flake)} · {flake.evidence.length} detection
            {flake.evidence.length === 1 ? "" : "s"} · updated{" "}
            {formatRelative(flake.updatedAt, now)}
          </p>
        </div>
        <StatusControl projectId={projectId} flake={flake} />
      </div>
      <FlakeHistory flake={flake} />
      {latest && (
        <div className="space-y-1">
          <FlakeRuns evidence={latest} />
          <Link
            to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
            params={{ projectId, buildId: latest.buildId, snapshotId: latest.snapshotId }}
            className="text-sm text-violet-700 hover:underline"
          >
            See the shot
          </Link>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-600">
          Policy: {policy}. Change it in config
        </summary>
        <div className="mt-2">
          <FlakyPolicyControl policy={policy} />
        </div>
      </details>
    </li>
  );
}

function FlakesPage() {
  const { project, org, flakes, now } = Route.useLoaderData();
  const open = flakes.filter((f) => f.status === "open").length;
  return (
    <Page
      title={`${project.name} · flakes`}
      crumbs={[orgCrumb(org), projectCrumb(project), "Flakes"]}
    >
      <p className="mb-4 text-slate-600">
        {flakes.length === 0
          ? "No flakes. A shot is flaky when the CLI captured it again and the captures disagreed, or when a reviewer marked it."
          : `${open} open, ${flakes.length - open} resolved. Open flakes first.`}
      </p>
      <ul className="space-y-4">
        {flakes.map((flake) => (
          <FlakeItem key={flake.id} projectId={project.id} flake={flake} now={now} />
        ))}
      </ul>
    </Page>
  );
}
