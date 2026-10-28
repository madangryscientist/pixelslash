import {
  Button,
  Caption,
  Card,
  CopyButton,
  SectionHeading,
  Stack,
  SubsectionHeading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
} from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { type Variant, variantLabel } from "#/components/override-trail";
import type { IgnoreRect } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { clearIgnoreBoxFromSettings } from "#/server/ignore-boxes";

/** Review-UI ignore boxes (ob 1499) on the settings page: the list, clear one, the audit trail. */

type Box = {
  id: string;
  name: string;
  variant: Variant | null;
  rect: IgnoreRect;
  by: string;
  at: Date;
  cleared: { by: string; at: Date } | null;
};

const rectText = (r: IgnoreRect) => `${r.width}×${r.height} at ${r.x},${r.y}`;

function ClearBox({
  projectId,
  boxId,
  hydrated,
}: {
  projectId: string;
  boxId: string;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = () => {
    setBusy(true);
    setError(null);
    clearIgnoreBoxFromSettings({ data: { projectId, boxId } })
      .then(() => router.invalidate())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button
        variant="ghost"
        disabled={!hydrated}
        busy={busy}
        busyLabel="Clearing…"
        onClick={clear}
        tone="danger"
        data-testid="ignore-list-clear"
      >
        Clear
      </Button>
      {error && (
        <Caption as="p" role="alert" tone="danger">
          {error}
        </Caption>
      )}
    </>
  );
}

function TestCell({ box }: { box: Box }) {
  return (
    <TableCell tone="strong" secondary={variantLabel(box.variant)}>
      {box.name}
    </TableCell>
  );
}

/** Every box ever drawn, newest first: who drew it, and who cleared it. */
function BoxTrail({ trail }: { trail: Box[] }) {
  if (trail.length === 0)
    return (
      <Text as="p" color="muted" data-testid="no-ignore-trail">
        No boxes were drawn in the review screen.
      </Text>
    );
  return (
    <Table variant="plain" caption="Ignore boxes drawn in review" data-testid="ignore-trail">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Box</TableHeaderCell>
          <TableHeaderCell>Drawn</TableHeaderCell>
          <TableHeaderCell>Cleared</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {trail.map((b) => (
          <TableRow key={b.id} data-testid="ignore-trail-row">
            <TestCell box={b} />
            <TableCell mono>{rectText(b.rect)}</TableCell>
            <TableCell>
              @{b.by}, {formatDateTime(b.at)}
            </TableCell>
            <TableCell>
              {b.cleared ? `@${b.cleared.by}, ${formatDateTime(b.cleared.at)}` : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function IgnoreBoxSettings({
  projectId,
  boxes,
  trail,
  hydrated,
}: {
  projectId: string;
  boxes: (Box & { snippet: string })[];
  trail: Box[];
  hydrated: boolean;
}) {
  return (
    <Card data-testid="ignore-box-settings">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Ignore boxes drawn in review</SectionHeading>
          <Text as="p">
            Drawn on a shot&apos;s screen, for a test or one variant of it, in image px; the server
            diff skips them along with the config&apos;s and manifest&apos;s areas. The export above
            carries them. Clearing one measures those pixels again from the next build.
          </Text>
        </Stack>
        {boxes.length === 0 ? (
          <Text as="p" color="muted" data-testid="no-ignore-boxes">
            None. Draw one from a shot&apos;s screen.
          </Text>
        ) : (
          <Table variant="plain" caption="Ignore boxes">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Test</TableHeaderCell>
                <TableHeaderCell>Box</TableHeaderCell>
                <TableHeaderCell>Drawn</TableHeaderCell>
                <TableHeaderCell align="end" srLabel="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {boxes.map((b) => (
                <TableRow key={b.id} data-testid="ignore-row">
                  <TestCell box={b} />
                  <TableCell mono>{rectText(b.rect)}</TableCell>
                  <TableCell>
                    @{b.by}, {formatDateTime(b.at)}
                  </TableCell>
                  <TableCell align="end">
                    <CopyButton text={b.snippet} disabled={!hydrated} />
                    <ClearBox projectId={projectId} boxId={b.id} hydrated={hydrated} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <SubsectionHeading>Trail</SubsectionHeading>
        <BoxTrail trail={trail} />
      </Stack>
    </Card>
  );
}
