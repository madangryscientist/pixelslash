import { Button, Card, CopyLine, Stack } from "@hackcove/ui";

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
    <Card as="div" dashed="filled" data-testid="empty-org">
      <h2 className="mb-1.5 text-[17px] font-semibold">No projects yet</h2>
      <p className="mx-auto mb-4 max-w-[460px] text-slate-600">
        A project holds one app's builds. Make one, issue a token in its settings, then upload from
        CI or your machine.
      </p>
      <Button disabled={!hydrated} onClick={onNewProject}>
        + New project
      </Button>
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
          <Stack gap="xs">
            <span>Upload a build:</span>
            <CopyLine text={command} data-testid="upload-command" />
          </Stack>
        </li>
      </ol>
    </Card>
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
