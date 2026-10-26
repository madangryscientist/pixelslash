import {
  Body,
  Button,
  Caption,
  Card,
  Cluster,
  Code,
  CodeBlock,
  CopyButton,
  Empty,
  Overline,
  SectionHeading,
  Stack,
  SubsectionHeading,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { DiffOptions } from "#/db/schema";
import { formatDateTime } from "#/lib/format";
import { clearDiffOverride } from "#/server/overrides";

/** Review-UI diff overrides (ob 1495) on the settings and build pages: the list, the audit trail. */

export type Variant = { platform: string; browser: string; viewport: string; theme: string };

type Change = {
  id: string;
  name: string;
  variant: Variant | null;
  before: DiffOptions | null;
  after: DiffOptions | null;
  by: string;
  at: Date;
};

type Listed = {
  name: string;
  variant: Variant | null;
  options: DiffOptions;
  by: string;
  at: Date;
  snippet: string;
};

export const variantLabel = (v: Variant | null) =>
  v ? `${v.platform} · ${v.browser} · ${v.viewport} · ${v.theme}` : "every variant";

/** `threshold 0.1, minChangedPixels 100`; none is the config's values. */
function optionsText(options: DiffOptions | null): string {
  const entries = Object.entries(options ?? {});
  if (entries.length === 0) return "config";
  return entries.map(([k, v]) => `${k} ${v}`).join(", ");
}

/** Who changed what, when, from what to what: newest first. */
function OverrideChanges({ changes }: { changes: Change[] }) {
  if (changes.length === 0)
    return (
      <Empty data-testid="no-override-changes">
        No thresholds were changed in the review screen.
      </Empty>
    );
  return (
    <Table variant="plain" caption="Thresholds changed in review" data-testid="override-changes">
      <TableHead>
        <TableRow>
          <TableHeaderCell>When</TableHeaderCell>
          <TableHeaderCell>Who</TableHeaderCell>
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Change</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {changes.map((c) => (
          <TableRow key={c.id} data-testid="override-change">
            <TableCell>{formatDateTime(c.at)}</TableCell>
            <TableCell>@{c.by}</TableCell>
            <TableCell tone="strong" secondary={variantLabel(c.variant)}>
              {c.name}
            </TableCell>
            <TableCell mono>
              {optionsText(c.before)} → {optionsText(c.after)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** A build page's trail: the threshold changes to its tests, or nothing when there are none. */
export function BuildOverrideChanges({ changes }: { changes: Change[] }) {
  if (changes.length === 0) return null;
  return (
    <Stack as="section" gap="xs" data-testid="build-override-changes">
      <Overline as="h2">Thresholds changed in review</Overline>
      <OverrideChanges changes={changes} />
    </Stack>
  );
}

function ClearButton({
  projectId,
  o,
  hydrated,
}: {
  projectId: string;
  o: Listed;
  hydrated: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = () => {
    setBusy(true);
    setError(null);
    clearDiffOverride({ data: { projectId, name: o.name, variant: o.variant } })
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
        data-testid="override-list-clear"
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

/** The overrides and ignore boxes as the config a route would carry, to copy. */
function ExportAsConfig({ exported, hydrated }: { exported: string; hydrated: boolean }) {
  return (
    <details className="space-y-2 text-sm" data-testid="override-export">
      <summary className="cursor-pointer text-violet-700">Export as config</summary>
      <Body as="p" tone="muted">
        Merge each route&apos;s <Code>diff</Code>, <Code>ignore</Code> and <Code>variants</Code>{" "}
        into the route of that name in <Code>pixelslash.config.json</Code>, then clear the overrides
        and ignore boxes here: the builds measure the same. A key the config already sets on that
        variant beats a route&apos;s; move it to the variant. Ignore boxes are in image px, the
        config&apos;s in CSS px: the same at a deviceScaleFactor of 1, otherwise divide by it.
      </Body>
      <Cluster justify="end">
        <CopyButton text={exported} disabled={!hydrated} />
      </Cluster>
      <CodeBlock data-testid="override-export-json">{exported}</CodeBlock>
    </details>
  );
}

/**
 * The settings page's section: every override, clear one, export them all (with the ignore boxes,
 * ob 1499), and the trail.
 */
export function OverrideSettings({
  projectId,
  overrides,
  hydrated,
}: {
  projectId: string;
  overrides: { list: Listed[]; changes: Change[]; boxes: unknown[]; exported: string };
  hydrated: boolean;
}) {
  return (
    <Card data-testid="diff-overrides">
      <Stack>
        <Stack gap="xs">
          <SectionHeading>Diff thresholds set in review</SectionHeading>
          <Body as="p">
            Set from a shot&apos;s screen, for a test or one variant of it; they beat the
            config&apos;s values. Clearing one applies the config&apos;s again from the next build.
          </Body>
        </Stack>
        {overrides.list.length === 0 ? (
          <Empty data-testid="no-overrides">None. Set one from a shot&apos;s screen.</Empty>
        ) : (
          <Table variant="plain" caption="Diff thresholds set in review">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Test</TableHeaderCell>
                <TableHeaderCell>Options</TableHeaderCell>
                <TableHeaderCell>Set</TableHeaderCell>
                <TableHeaderCell align="end" srLabel="Actions" />
              </TableRow>
            </TableHead>
            <TableBody>
              {overrides.list.map((o) => (
                <TableRow key={`${o.name}\n${variantLabel(o.variant)}`} data-testid="override-row">
                  <TableCell tone="strong" secondary={variantLabel(o.variant)}>
                    {o.name}
                  </TableCell>
                  <TableCell mono>{optionsText(o.options)}</TableCell>
                  <TableCell>
                    @{o.by}, {formatDateTime(o.at)}
                  </TableCell>
                  <TableCell align="end">
                    <CopyButton text={o.snippet} disabled={!hydrated} />
                    <ClearButton projectId={projectId} o={o} hydrated={hydrated} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(overrides.list.length > 0 || overrides.boxes.length > 0) && (
          <ExportAsConfig exported={overrides.exported} hydrated={hydrated} />
        )}
        <SubsectionHeading>Changes</SubsectionHeading>
        <OverrideChanges changes={overrides.changes} />
      </Stack>
    </Card>
  );
}
