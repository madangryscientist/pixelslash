import { ActionButton } from "./action-button";
import { CopyLine } from "./copy-button";

/** An org with no projects: what a project is, and the two steps to a first build. */
export function EmptyOrg({
  serverUrl,
  onNewProject,
  hydrated,
}: {
  serverUrl: string;
  onNewProject: () => void;
  hydrated: boolean;
}) {
  const command = `PIXELSLASH_TOKEN=… pixelslash upload DIR --server ${serverUrl}`;
  return (
    <div
      data-testid="empty-org"
      className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
    >
      <h2 className="mb-1.5 text-[17px] font-semibold">No projects yet</h2>
      <p className="mx-auto mb-4 max-w-[460px] text-slate-600">
        A project holds one app's builds. Make one, issue a token in its settings, then upload from
        CI or your machine.
      </p>
      <ActionButton waiting={!hydrated} onClick={onNewProject}>
        + New project
      </ActionButton>
      <ol className="mx-auto mt-5 grid max-w-140 gap-2.5 text-left text-slate-600">
        <li className="grid grid-cols-[26px_1fr] items-start gap-2.5">
          <Step n={1} />
          <span>
            Create a project and open{" "}
            <b className="font-medium text-slate-900">Settings → Issue token</b>.
          </span>
        </li>
        <li className="grid grid-cols-[26px_1fr] items-start gap-2.5">
          <Step n={2} />
          <div className="min-w-0">
            Upload a build:
            <CopyLine
              text={command}
              hydrated={hydrated}
              testId="upload-command"
              className="mt-1.5"
            />
          </div>
        </li>
      </ol>
    </div>
  );
}

/** A numbered step in an empty state's how-to. */
export function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-5.5 w-5.5 place-items-center rounded-full bg-(--ps-brand-soft) text-xs font-bold text-violet-600"
    >
      {n}
    </span>
  );
}
