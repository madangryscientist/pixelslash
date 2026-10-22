import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "#/components/copy-button";
import type { IgnoreSource } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffResult, IgnoreRect } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { EDGE_WARNING, edgeTouches } from "#/lib/ignore-edge";
import { addIgnoreBoxFn, clearIgnoreBoxFn } from "#/server/ignore-boxes";
import { ActionButton } from "./action-button";

/**
 * Ignore boxes drawn on a shot's screen (ob 1499): drag a box over the image, then ignore it for
 * this test or for this test in this variant. Saving re-diffs the open build at once; later builds
 * read it too. Each box has its config snippet, so nothing drawn here is only here.
 */

type Scope = "test" | "variant";

type ShownBox = {
  id: string;
  rect: IgnoreRect;
  variant: unknown;
  by: string;
  at: Date;
  snippet: string;
};

type Ids = { projectId: string; buildId: string; snapshotId: string };

/** Drawing a box and the box drawn, until it is saved or dropped; a new shot starts over. */
export function useIgnoreDraft(snapshotId: string) {
  const [drawing, setDrawing] = useState(false);
  const [rect, setRect] = useState<IgnoreRect | null>(null);
  const [shot, setShot] = useState(snapshotId);
  const reset = () => {
    setDrawing(false);
    setRect(null);
  };
  if (shot !== snapshotId) {
    setShot(snapshotId);
    reset();
  }
  // The draw layer keeps fractions out, but the server takes whole px only.
  const onDraw = drawing
    ? (drawn: IgnoreRect) => {
        setRect({
          x: Math.round(drawn.x),
          y: Math.round(drawn.y),
          width: Math.max(1, Math.round(drawn.width)),
          height: Math.max(1, Math.round(drawn.height)),
        });
        setDrawing(false);
      }
    : null;
  return { drawing, setDrawing, rect, reset, onDraw };
}

type IgnoreDraft = ReturnType<typeof useIgnoreDraft>;

function noteOf(saved: {
  changed: boolean;
  rediffed: number;
  status: string;
  note: string | null;
}) {
  if (!saved.changed) return "Nothing changed.";
  if (saved.note) return saved.note;
  const shots = saved.rediffed === 1 ? "1 shot" : `${saved.rediffed} shots`;
  return `Saved. Re-diffed ${shots}; the build is ${saved.status}.`;
}

function useBoxes(ids: Ids, draft: IgnoreDraft) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = (work: Promise<Parameters<typeof noteOf>[0]>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    work
      .then((saved) => {
        setNote(noteOf(saved));
        draft.reset();
        return router.invalidate();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return {
    busy,
    error,
    note,
    add: (scope: Scope, rect: IgnoreRect) => run(addIgnoreBoxFn({ data: { ...ids, scope, rect } })),
    clear: (boxId: string) =>
      run(clearIgnoreBoxFn({ data: { projectId: ids.projectId, buildId: ids.buildId, boxId } })),
  };
}

/** The changed regions that touch an ignored area's edge, measured against the areas used. */
export function EdgeWarning({ result }: { result: DiffResult | null }) {
  const touching = result ? edgeTouches(result.regions, result.ignored) : [];
  if (touching.length === 0) return null;
  return (
    <p
      role="status"
      data-testid="ignore-edge-warning"
      className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800"
    >
      {touching.length === 1 ? "A change touches" : `${touching.length} changes touch`} an ignored
      area's edge: {EDGE_WARNING}.
    </p>
  );
}

function PendingBox({
  rect,
  busy,
  waiting,
  onSave,
  onCancel,
}: {
  rect: IgnoreRect;
  busy: boolean;
  waiting: boolean;
  onSave: (scope: Scope) => void;
  onCancel: () => void;
}) {
  return (
    <div data-testid="ignore-pending" className="space-y-1.5">
      <p className="text-xs text-slate-600">
        {rect.width}×{rect.height} px at {rect.x},{rect.y}
      </p>
      <ActionButton
        waiting={waiting}
        busy={busy}
        busyLabel="Saving…"
        onClick={() => onSave("test")}
        className="w-full px-3 py-1.5"
        data-testid="ignore-save-test"
      >
        Ignore for this test
      </ActionButton>
      <ActionButton
        variant="outline"
        waiting={waiting}
        busy={busy}
        busyLabel="Saving…"
        onClick={() => onSave("variant")}
        className="w-full px-3 py-1.5"
        data-testid="ignore-save-variant"
      >
        This test, this variant
      </ActionButton>
      <ActionButton
        variant="ghost"
        waiting={waiting}
        disabledReason={busy ? "Saving" : undefined}
        onClick={onCancel}
        className="w-full px-3 py-1.5"
      >
        Cancel
      </ActionButton>
    </div>
  );
}

function BoxRow({
  box,
  busy,
  hydrated,
  onClear,
}: {
  box: ShownBox;
  busy: boolean;
  hydrated: boolean;
  onClear: () => void;
}) {
  return (
    <li data-testid="ignore-box-row" className="rounded-lg border border-slate-200 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">
          <span className="mr-1 rounded bg-sky-800 px-1 text-[10px] text-white">UI</span>
          {box.variant ? "This variant" : "This test"} · {box.rect.width}×{box.rect.height}
        </span>
        <ActionButton
          variant="outline"
          waiting={!hydrated}
          busy={busy}
          busyLabel="Clearing…"
          onClick={onClear}
          className="px-2 py-1 text-xs"
          data-testid="ignore-clear"
        >
          Clear
        </ActionButton>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
        <span>
          By @{box.by}, {formatDateTime(box.at)}. Copy as config:
        </span>
        <CopyButton text={box.snippet} hydrated={hydrated} />
      </div>
      <pre
        data-testid="ignore-snippet"
        className="mt-1 overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono text-[11.5px] text-slate-800"
      >
        {box.snippet}
      </pre>
    </li>
  );
}

export function IgnoreBoxes({
  project,
  build,
  snapshot,
  ignoreBoxes,
  uploadedIgnore,
  draft,
}: {
  project: { id: string; diffLocation: string };
  build: { id: string };
  snapshot: { id: string; diffStatus: string | null; ignore: IgnoreRect[] };
  ignoreBoxes: ShownBox[];
  uploadedIgnore: Exclude<IgnoreSource, "UI">;
  draft: IgnoreDraft;
}) {
  const hydrated = useHydrated();
  const boxes = useBoxes(
    { projectId: project.id, buildId: build.id, snapshotId: snapshot.id },
    draft,
  );
  if (project.diffLocation !== "server" || snapshot.diffStatus === "removed") return null;
  const uploaded = snapshot.ignore.length;
  return (
    <section data-testid="ignore-boxes" className="space-y-2">
      <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Ignore areas</h2>
      {uploaded > 0 && (
        <p className="text-xs text-slate-600">
          {uploaded} from the {uploadedIgnore}, hatched on the shot.
        </p>
      )}
      {ignoreBoxes.length > 0 && (
        <ul className="space-y-2">
          {ignoreBoxes.map((box) => (
            <BoxRow
              key={box.id}
              box={box}
              busy={boxes.busy}
              hydrated={hydrated}
              onClear={() => boxes.clear(box.id)}
            />
          ))}
        </ul>
      )}
      {draft.rect ? (
        <PendingBox
          rect={draft.rect}
          busy={boxes.busy}
          waiting={!hydrated}
          onSave={(scope) => draft.rect && boxes.add(scope, draft.rect)}
          onCancel={draft.reset}
        />
      ) : (
        <ActionButton
          variant={draft.drawing ? "primary" : "outline"}
          aria-pressed={draft.drawing}
          waiting={!hydrated}
          onClick={() => draft.setDrawing(!draft.drawing)}
          className="w-full px-3 py-1.5"
          data-testid="ignore-draw"
        >
          {draft.drawing ? "Drag over the shot…" : "Draw ignore box"}
        </ActionButton>
      )}
      <p className="text-xs text-slate-500">
        In image px. Saving re-diffs this build now, and every later build reads it.
      </p>
      {boxes.error && (
        <p role="alert" className="text-sm text-red-700">
          {boxes.error}
        </p>
      )}
      {boxes.note && (
        <p data-testid="ignore-note" className="text-sm text-slate-600">
          {boxes.note}
        </p>
      )}
    </section>
  );
}
