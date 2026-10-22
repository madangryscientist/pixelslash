import { Button, Input, Pill, buttonClass } from "@hackcove/ui";
import { Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ActionButton } from "#/components/action-button";
import type { ProjectFlag, SnapshotFlag } from "#/db/flags";
import type { FlagKind, IgnoreRect } from "#/db/schema";
import { flagShot, withdrawShotFlag } from "#/server/fns";

const FLAG_LABELS: Record<FlagKind, string> = {
  missed: "Missed change",
  false_positive: "False positive",
};

/** In the form's order. Not the schema's FLAG_KINDS: that module is the server's, not the page's. */
const KINDS = ["false_positive", "missed"] as const satisfies readonly FlagKind[];

const KIND_HINTS: Record<FlagKind, string> = {
  missed: "The diff says unchanged or under threshold, but something visibly changed.",
  false_positive: "The diff flags a change that is not real: anti-aliasing, a shift, jitter.",
};

const rectText = (rect: IgnoreRect) => `${rect.width}×${rect.height} at ${rect.x},${rect.y}`;

/**
 * The flag form's draft, owned by the page because the viewer draws its rect. Moving to another
 * shot (j/k keeps the page mounted) drops the draft, so it never follows the reviewer.
 */
export function useFlagDraft(
  snapshotId: string,
  flags: SnapshotFlag[],
  /** False when nothing was measured: there is no image size to draw in. */
  canDraw: boolean,
) {
  const mine = flags.find((flag) => flag.mine) ?? null;
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<IgnoreRect | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [shot, setShot] = useState(snapshotId);
  const close = () => {
    setOpen(false);
    setDrawing(false);
    setRect(null);
  };
  if (shot !== snapshotId) {
    setShot(snapshotId);
    close();
  }
  const toggle = () => {
    if (open) {
      close();
    } else {
      setRect(mine?.rect ?? null);
      setOpen(true);
    }
  };
  // While the form is open, its rect stands in for the viewer's saved one.
  const marks = flags
    .filter((flag) => !(open && flag.mine))
    .flatMap((flag) => (flag.rect ? [flag.rect] : []));
  if (open && rect) marks.push(rect);
  const onDraw = drawing
    ? (drawn: IgnoreRect) => {
        setRect(drawn);
        setDrawing(false);
      }
    : null;
  return { mine, open, toggle, close, rect, setRect, drawing, setDrawing, canDraw, marks, onDraw };
}

type FlagDraft = ReturnType<typeof useFlagDraft>;

/** Every reviewer's flag on this shot: a second reviewer sees the first's kind and note. */
function FlagList({ flags }: { flags: SnapshotFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">
        Detection flags
      </h2>
      <ul className="space-y-2 text-sm">
        {flags.map((flag) => (
          <li key={flag.id} data-testid="detection-flag" data-kind={flag.kind}>
            <Pill tone={flag.kind === "missed" ? "amber" : "blue"}>{FLAG_LABELS[flag.kind]}</Pill>
            <span className="ml-2 text-slate-500">by {flag.mine ? "you" : flag.by}</span>
            {flag.note && <p className="mt-1 text-slate-700">{flag.note}</p>}
            {flag.rect && <p className="mt-0.5 text-xs text-slate-500">{rectText(flag.rect)}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function KindPicker({ kind, onKind }: { kind: FlagKind | null; onKind: (kind: FlagKind) => void }) {
  return (
    <>
      {KINDS.map((option) => (
        <label key={option} className="flex items-start gap-2">
          <input
            type="radio"
            name="flag-kind"
            value={option}
            checked={kind === option}
            onChange={() => onKind(option)}
            className="mt-1"
          />
          <span>
            {FLAG_LABELS[option]}
            <span className="block text-xs text-slate-500">{KIND_HINTS[option]}</span>
          </span>
        </label>
      ))}
    </>
  );
}

function drawLabel(draft: FlagDraft): string {
  if (draft.drawing) return "Drawing…";
  return draft.rect ? "Redraw area" : "Mark an area";
}

/** Mark an optional area on the shot: the button turns drawing on, the viewer takes the drag. */
function AreaPicker({ draft }: { draft: FlagDraft }) {
  const { canDraw } = draft;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={draft.drawing ? "primary" : "outline"}
        aria-pressed={draft.drawing}
        disabled={!canDraw}
        title={canDraw ? "Drag a box on either shot" : "Nothing was measured to draw on"}
        onClick={() => draft.setDrawing(!draft.drawing)}
        className="px-2.5 py-1"
      >
        {drawLabel(draft)}
      </Button>
      {draft.rect && (
        <>
          <span data-testid="flag-rect" className="text-xs text-slate-500">
            {rectText(draft.rect)}
          </span>
          <Button
            type="button"
            variant="ghost"
            onClick={() => draft.setRect(null)}
            className="px-2 py-1"
          >
            Clear
          </Button>
        </>
      )}
    </div>
  );
}

/** Run a flag write, reload the page's data, and close the form; a failure stays on screen. */
export function useFlagWrite(onDone: () => void) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work()
      .then(() => router.invalidate())
      .then(onDone)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return { busy, error, run };
}

/** Create, edit or withdraw the viewer's own flag. Saving decides nothing about the shot. */
function FlagForm({
  projectId,
  snapshotId,
  draft,
}: {
  projectId: string;
  snapshotId: string;
  draft: FlagDraft;
}) {
  const { mine } = draft;
  const [kind, setKind] = useState<FlagKind | null>(mine?.kind ?? null);
  const [note, setNote] = useState(mine?.note ?? "");
  const { busy, error, run } = useFlagWrite(draft.close);
  const ids = { projectId, snapshotId };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (kind) run(() => flagShot({ data: { ...ids, kind, note, rect: draft.rect } }));
  };

  return (
    <form
      onSubmit={save}
      aria-label="Flag detection"
      className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/40 p-3 text-sm"
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 font-medium">{mine ? "Edit your flag" : "Flag detection"}</legend>
        <KindPicker kind={kind} onKind={setKind} />
      </fieldset>
      <Input
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        value={note}
        maxLength={200}
        onChange={(e) => setNote(e.target.value)}
        className="w-full px-3"
      />
      <AreaPicker draft={draft} />
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ActionButton
          type="submit"
          disabledReason={kind ? undefined : "Pick missed change or false positive"}
          busy={busy}
          busyLabel="Saving…"
          className="px-3 py-1.5"
        >
          {mine ? "Save flag" : "Flag"}
        </ActionButton>
        {mine && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => withdrawShotFlag({ data: ids }))}
            className="px-3 py-1.5"
          >
            Withdraw
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={draft.close} className="px-3 py-1.5">
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The side panel's flag section: the form while it is open, then everyone's flags. */
export function FlagPanel({
  projectId,
  snapshotId,
  flags,
  draft,
}: {
  projectId: string;
  snapshotId: string;
  flags: SnapshotFlag[];
  draft: FlagDraft;
}) {
  return (
    <>
      {draft.open && <FlagForm projectId={projectId} snapshotId={snapshotId} draft={draft} />}
      <FlagList flags={flags} />
    </>
  );
}

/**
 * The project's flags, newest first, each linking to its shot; the export is the same list as
 * JSON with the blob keys and rects. Nothing here is sent anywhere: the file is downloaded.
 */
export function ProjectFlags({ projectId, flags }: { projectId: string; flags: ProjectFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <section aria-labelledby="detection-flags" className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="detection-flags" className="text-[15px] font-semibold">
          Detection flags <span className="font-normal text-slate-500">{flags.length}</span>
        </h2>
        <a href={`/projects/${projectId}/flags.json`} download className={buttonClass("outline")}>
          Export JSON
        </a>
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {flags.map((flag) => (
          <li
            key={flag.id}
            data-testid="project-flag"
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 text-sm"
          >
            <Pill tone={flag.kind === "missed" ? "amber" : "blue"}>{FLAG_LABELS[flag.kind]}</Pill>
            <Link
              to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
              params={{ projectId, buildId: flag.build.id, snapshotId: flag.snapshot.id }}
              className="font-medium text-violet-700 hover:underline"
            >
              {flag.snapshot.name}
            </Link>
            <span className="text-slate-500">on {flag.build.branch}</span>
            <span className="text-slate-400">by {flag.by}</span>
            {flag.note && <span className="basis-full text-slate-700">{flag.note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
