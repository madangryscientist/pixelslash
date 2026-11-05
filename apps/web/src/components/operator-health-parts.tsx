import { Card, Caption, Section, TableCell, Text } from "@hackcove/ui-react";
import type { Reading } from "#/lib/reading";
import type { StepStats } from "#/lib/timings";
import { formatDuration, formatNumber } from "#/lib/format";

/** Pieces shared by the operator health page's sections (PS-330). */

/** A reading as text: its value, or `unavailable` and the reason, never a 0. */
export function Figure<T>({
  reading,
  children,
  testId,
}: {
  reading: Reading<T>;
  children: (value: T) => string;
  testId: string;
}) {
  if (reading.ok) return <Text data-testid={testId}>{children(reading.value)}</Text>;
  return (
    <Text tone="muted" data-testid={testId}>
      unavailable: {reading.why}
    </Text>
  );
}

export const plural = (n: number, noun: string) =>
  `${formatNumber(n)} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One section of the health page: @hackcove/ui-react's `Section` (its heading names the section) inside
 * a card, with the note that says what the numbers cover as its first line. Not named `Section`, so it
 * cannot be mistaken for the library's export (the hackcove UI review checks for that).
 */
export function HealthSection({
  title,
  note,
  testId,
  children,
}: {
  title: string;
  note: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Section gap="xs" title={title} data-testid={testId}>
        <Caption as="p">{note}</Caption>
        {children}
      </Section>
    </Card>
  );
}

export function StepCell({ stats }: { stats: StepStats | null }) {
  if (!stats) return <TableCell tone="muted">—</TableCell>;
  return (
    <TableCell numeric secondary={plural(stats.n, "build")}>
      {formatDuration(stats.p50, { exact: true })} <Text tone="muted">/</Text>{" "}
      {formatDuration(stats.tail === "max" ? stats.max : stats.p95, { exact: true })}
      {stats.tail === "max" && (
        <>
          {" "}
          <Text tone="muted">max</Text>
        </>
      )}{" "}
      <Text tone="muted">/</Text>{" "}
      {stats.p99 === null ? "—" : formatDuration(stats.p99, { exact: true })}
    </TableCell>
  );
}
