import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useHydrated } from "#/components/ui";
import { rerunBuildShots } from "#/server/rerun";
import { ActionButton } from "./action-button";

/**
 * Partial re-runs (ob 1738): the server measures the named shots again from the PNGs it holds, and
 * nothing else. Only a server-diff project shows these; a CI project re-runs its CI job.
 */

/** A build with a verdict, whose shots are all measured: one of them may be re-diffed. */
const hasVerdict = (status: string) =>
  status === "changes" || status === "passed" || status === "failed";

function useRerun(projectId: string, buildId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (snapshotId: string | null) => {
    setBusy(true);
    setError(null);
    rerunBuildShots({ data: { projectId, buildId, snapshotId } })
      .then(() => router.invalidate())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

function RerunError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-red-700">
      {error}
    </p>
  );
}

/** On an errored build's page: measure again only the shots that errored or were left unmeasured. */
export function RerunErrored({ projectId, buildId }: { projectId: string; buildId: string }) {
  const hydrated = useHydrated();
  const { busy, error, run } = useRerun(projectId, buildId);
  return (
    <div className="mt-2">
      <ActionButton
        variant="outline"
        waiting={!hydrated}
        busy={busy}
        busyLabel="Re-running…"
        onClick={() => run(null)}
        className="px-3 py-1.5"
        data-testid="rerun-errored"
      >
        Re-run errored shots
      </ActionButton>
      <RerunError error={error} />
    </div>
  );
}

/**
 * On a shot's side panel: re-diff this one shot. A review it had stays if the result does not move.
 * Only on a build with a verdict (an errored one has the build's button), and not for a removed
 * marker, which has no image of its own.
 */
export function RerunShot({
  project,
  build,
  snapshot,
}: {
  project: { id: string; diffLocation: string };
  build: { id: string; status: string };
  snapshot: { id: string; diffStatus: string | null };
}) {
  if (project.diffLocation !== "server" || !hasVerdict(build.status)) return null;
  if (snapshot.diffStatus === "removed") return null;
  return <RerunShotButton projectId={project.id} buildId={build.id} snapshot={snapshot} />;
}

function RerunShotButton({
  projectId,
  buildId,
  snapshot,
}: {
  projectId: string;
  buildId: string;
  snapshot: { id: string };
}) {
  const hydrated = useHydrated();
  const { busy, error, run } = useRerun(projectId, buildId);
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Re-run</h2>
      <p className="mb-2 text-sm text-slate-600">
        Measure this shot again from the uploaded image. A review stays if the result is the same.
      </p>
      <ActionButton
        variant="outline"
        waiting={!hydrated}
        busy={busy}
        busyLabel="Re-running…"
        onClick={() => run(snapshot.id)}
        className="px-3 py-1.5"
        data-testid="rerun-shot"
      >
        Re-run this shot
      </ActionButton>
      <RerunError error={error} />
    </section>
  );
}
