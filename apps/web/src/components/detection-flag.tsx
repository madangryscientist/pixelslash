import {
  Body,
  BodyStrong,
  Button,
  ButtonGroup,
  ButtonLink,
  Caption,
  Card,
  Cluster,
  Input,
  ListRow,
  Overline,
  Pill,
  Radio,
  RadioGroup,
  Section,
  Stack,
  TextLink,
} from "@hackcove/ui";
import { Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
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
    <Stack as="section" gap="xs">
      <Overline as="h2" tone="muted">
        Detection flags
      </Overline>
      <Stack as="ul" gap="xs">
        {flags.map((flag) => (
          <li key={flag.id} data-testid="detection-flag" data-kind={flag.kind}>
            <Pill tone={flag.kind === "missed" ? "amber" : "blue"}>{FLAG_LABELS[flag.kind]}</Pill>{" "}
            <Body tone="muted">by {flag.mine ? "you" : flag.by}</Body>
            {flag.note && <Body as="p">{flag.note}</Body>}
            {flag.rect && (
              <Caption as="p" tone="muted">
                {rectText(flag.rect)}
              </Caption>
            )}
          </li>
        ))}
      </Stack>
    </Stack>
  );
}

function KindPicker({ kind, onKind }: { kind: FlagKind | null; onKind: (kind: FlagKind) => void }) {
  return (
    <RadioGroup
      name="flag-kind"
      label="Kind"
      value={kind ?? ""}
      onChange={(value) => KINDS.filter((option) => option === value).forEach(onKind)}
    >
      {KINDS.map((option) => (
        <Radio
          key={option}
          value={option}
          label={FLAG_LABELS[option]}
          description={KIND_HINTS[option]}
        />
      ))}
    </RadioGroup>
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
    <Cluster gap="xs" wrap>
      <Button
        type="button"
        variant="outline"
        pressed={draft.drawing}
        disabled={!canDraw}
        title={canDraw ? "Drag a box on either shot" : "Nothing was measured to draw on"}
        onClick={() => draft.setDrawing(!draft.drawing)}
        size="sm"
      >
        {drawLabel(draft)}
      </Button>
      {draft.rect && (
        <>
          <Caption data-testid="flag-rect" tone="muted">
            {rectText(draft.rect)}
          </Caption>
          <Button type="button" variant="ghost" onClick={() => draft.setRect(null)} size="sm">
            Clear
          </Button>
        </>
      )}
    </Cluster>
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
    <Card size="sm">
      <Stack as="form" gap="sm" onSubmit={save} aria-label="Flag detection">
        <fieldset>
          <legend>
            <BodyStrong>{mine ? "Edit your flag" : "Flag detection"}</BodyStrong>
          </legend>
          <KindPicker kind={kind} onKind={setKind} />
        </fieldset>
        <Input
          aria-label="Note (optional)"
          placeholder="Note (optional)"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
        <AreaPicker draft={draft} />
        {error && (
          <Body as="p" role="alert" tone="danger">
            {error}
          </Body>
        )}
        <ButtonGroup>
          <Button
            type="submit"
            disabledReason={kind ? undefined : "Pick missed change or false positive"}
            busy={busy}
            busyLabel="Saving…"
            size="sm"
          >
            {mine ? "Save flag" : "Flag"}
          </Button>
          {mine && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => run(() => withdrawShotFlag({ data: ids }))}
              size="sm"
            >
              Withdraw
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={draft.close} size="sm">
            Cancel
          </Button>
        </ButtonGroup>
      </Stack>
    </Card>
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
    <Section
      title={
        <>
          Detection flags <Body tone="muted">{flags.length}</Body>
        </>
      }
      actions={
        <ButtonLink variant="outline" href={`/projects/${projectId}/flags.json`} download>
          Export JSON
        </ButtonLink>
      }
    >
      <Card flush>
        {flags.map((flag, i) => (
          <ListRow
            key={flag.id}
            static
            divided={i > 0}
            data-testid="project-flag"
            leading={
              <Pill tone={flag.kind === "missed" ? "amber" : "blue"}>{FLAG_LABELS[flag.kind]}</Pill>
            }
          >
            <Cluster gap="xs" align="baseline" wrap>
              <TextLink
                render={(p) => (
                  <Link
                    to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
                    params={{ projectId, buildId: flag.build.id, snapshotId: flag.snapshot.id }}
                    {...p}
                  />
                )}
              >
                {flag.snapshot.name}
              </TextLink>
              <Body tone="muted">on {flag.build.branch}</Body>
              <Caption tone="muted">by {flag.by}</Caption>
            </Cluster>
            {flag.note && <Body as="p">{flag.note}</Body>}
          </ListRow>
        ))}
      </Card>
    </Section>
  );
}
