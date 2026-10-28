import {
  Button,
  ButtonGroup,
  Callout,
  Caption,
  Card,
  Cluster,
  CodeBlock,
  CopyButton,
  Overline,
  Pill,
  Stack,
  Text,
} from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { IgnoreSource } from "#/components/snapshot-frame";
import { useHydrated } from "#/components/ui";
import type { DiffResult, IgnoreRect } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { EDGE_WARNING, edgeTouches } from "#/lib/ignore-edge";
import { addIgnoreBoxFn, clearIgnoreBoxFn } from "#/server/ignore-boxes";

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

function DrawButton({ draft, hydrated }: { draft: IgnoreDraft; hydrated: boolean }) {
  return (
    <ButtonGroup>
      <Button
        variant="outline"
        pressed={draft.drawing}
        disabled={!hydrated}
        onClick={() => draft.setDrawing(!draft.drawing)}
        size="sm"
        data-testid="ignore-draw"
      >
        {draft.drawing ? "Drag over the shot…" : "Draw ignore box"}
      </Button>
    </ButtonGroup>
  );
}

/** The changed regions that touch an ignored area's edge, measured against the areas used. */
export function EdgeWarning({ result }: { result: DiffResult | null }) {
  const touching = result ? edgeTouches(result.regions, result.ignored) : [];
  if (touching.length === 0) return null;
  return (
    <Callout tone="warn" role="status" data-testid="ignore-edge-warning">
      {touching.length === 1 ? "A change touches" : `${touching.length} changes touch`} an ignored
      area's edge: {EDGE_WARNING}.
    </Callout>
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
    <Stack gap="xs" data-testid="ignore-pending">
      <Caption as="p" numeric>
        {rect.width}×{rect.height} px at {rect.x},{rect.y}
      </Caption>
      <ButtonGroup>
        <Button
          disabled={waiting}
          busy={busy}
          busyLabel="Saving…"
          onClick={() => onSave("test")}
          size="sm"
          data-testid="ignore-save-test"
        >
          Ignore for this test
        </Button>
        <Button
          variant="outline"
          disabled={waiting}
          busy={busy}
          busyLabel="Saving…"
          onClick={() => onSave("variant")}
          size="sm"
          data-testid="ignore-save-variant"
        >
          This test, this variant
        </Button>
        <Button
          variant="ghost"
          disabled={waiting}
          disabledReason={busy ? "Saving" : undefined}
          onClick={onCancel}
          size="sm"
        >
          Cancel
        </Button>
      </ButtonGroup>
    </Stack>
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
    <li>
      <Card as="div" size="sm" data-testid="ignore-box-row">
        <Stack gap="xs">
          <Cluster justify="between" gap="sm">
            <Text>
              <Pill tone="sky">UI</Pill> {box.variant ? "This variant" : "This test"} ·{" "}
              {box.rect.width}×{box.rect.height}
            </Text>
            <Button
              variant="outline"
              disabled={!hydrated}
              busy={busy}
              busyLabel="Clearing…"
              onClick={onClear}
              size="sm"
              data-testid="ignore-clear"
            >
              Clear
            </Button>
          </Cluster>
          <Cluster justify="between" gap="sm">
            <Caption>
              By @{box.by}, {formatDateTime(box.at)}. Copy as config:
            </Caption>
            <CopyButton text={box.snippet} disabled={!hydrated} />
          </Cluster>
          <CodeBlock data-testid="ignore-snippet">{box.snippet}</CodeBlock>
        </Stack>
      </Card>
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
    <Stack as="section" gap="xs" data-testid="ignore-boxes">
      <Overline as="h2">Ignore areas</Overline>
      {uploaded > 0 && (
        <Caption as="p">
          {uploaded} from the {uploadedIgnore}, hatched on the shot.
        </Caption>
      )}
      {ignoreBoxes.length > 0 && (
        <Stack as="ul" gap="xs">
          {ignoreBoxes.map((box) => (
            <BoxRow
              key={box.id}
              box={box}
              busy={boxes.busy}
              hydrated={hydrated}
              onClear={() => boxes.clear(box.id)}
            />
          ))}
        </Stack>
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
        <DrawButton draft={draft} hydrated={hydrated} />
      )}
      <Caption as="p">In image px; saving re-diffs this build and later ones.</Caption>
      {boxes.error && (
        <Text as="p" role="alert" tone="danger">
          {boxes.error}
        </Text>
      )}
      {boxes.note && (
        <Text as="p" tone="muted" data-testid="ignore-note">
          {boxes.note}
        </Text>
      )}
    </Stack>
  );
}
