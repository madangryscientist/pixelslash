import { useState } from "react";
import { ActionButton } from "./action-button";

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
            <div className="mt-1.5 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-2.5 py-2 font-mono text-[12.5px] text-slate-900">
              <code data-testid="upload-command" className="min-w-0 break-words">
                {command}
              </code>
              <CopyButton text={command} hydrated={hydrated} />
            </div>
          </div>
        </li>
      </ol>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-5.5 w-5.5 place-items-center rounded-full bg-(--ps-brand-soft) text-xs font-bold text-violet-600"
    >
      {n}
    </span>
  );
}

function CopyButton({ text, hydrated }: { text: string; hydrated: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      disabled={!hydrated}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      className="shrink-0 rounded font-sans text-xs text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-violet-600"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
