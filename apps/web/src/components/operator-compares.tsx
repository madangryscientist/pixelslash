import {
  Caption,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
} from "@hackcove/ui-react";
import type { BuildCompares } from "#/db/build-compares";
import type { WindowFigures } from "#/db/window-figures";
import { formatDuration, formatNumber } from "#/lib/format";
import { P95_MIN_BUILDS, P99_MIN_COMPARES, type StepStats } from "#/lib/timings";

/** Each build's snapshots and compare times on the operator health page (PS-336). */

const ms = (v: number) => formatDuration(v, { exact: true });

/** The three time cells of a build. No percentile stands for a compare that did not run. */
function Times({ build }: { build: BuildCompares }) {
  const { times, compared, snapshots, cacheHits } = build;
  if (!times) {
    let why = "no compare time stored";
    if (compared === 0 && cacheHits > 0)
      why =
        cacheHits === snapshots
          ? "all cache hits, no compare ran"
          : `no compare ran; ${formatNumber(cacheHits)} cache hits`;
    else if (compared === 0) why = "no compare";
    return (
      <TableCell colSpan={3} tone="muted">
        {why}
      </TableCell>
    );
  }
  const n = `n=${formatNumber(times.n)}`;
  return (
    <>
      <TableCell numeric align="end" secondary={n}>
        {ms(times.p50)}
      </TableCell>
      <TableCell numeric align="end" secondary={n}>
        {times.tail === "max" ? `${ms(times.max)} max` : ms(times.p95)}
      </TableCell>
      <TableCell numeric align="end" secondary={n}>
        {times.p99 === null ? "—" : ms(times.p99)}
      </TableCell>
    </>
  );
}

/** `p50 / p95 / p99 · n`: the p95 reads max under its gate and the p99 a dash under its own. */
function Figures({
  stats,
  unit,
  noun,
  testId,
}: {
  stats: StepStats | null;
  unit: (v: number) => string;
  noun: string;
  testId: string;
}) {
  if (!stats)
    return (
      <Text tone="muted" data-testid={testId}>
        — · n=0 {noun}
      </Text>
    );
  return (
    <Text data-testid={testId}>
      {unit(stats.p50)} / {unit(stats.tail === "max" ? stats.max : stats.p95)}
      {stats.tail === "max" && " max"} / {stats.p99 === null ? "—" : unit(stats.p99)} · n=
      {formatNumber(stats.n)} {noun}
    </Text>
  );
}

/**
 * The window's two figures above the per-build table (PS-342): how many snapshots a build holds and
 * how long a snapshot's compare takes, over every build that ended in the window. The per-build
 * table below cannot say it: a build rarely has the compares a p99 needs.
 */
export function WindowFiguresLine({ figures, testId }: { figures: WindowFigures; testId: string }) {
  return (
    <Stack gap="xs" data-testid={testId}>
      <Text as="p">
        Snapshots per build, p50 / p95 / p99:{" "}
        <Figures
          stats={figures.perBuild}
          unit={formatNumber}
          noun="builds"
          testId={`${testId}-per-build`}
        />
      </Text>
      <Text as="p">
        Time per snapshot, p50 / p95 / p99:{" "}
        <Figures
          stats={figures.perSnapshot}
          unit={ms}
          noun="compares"
          testId={`${testId}-per-snapshot`}
        />
      </Text>
      <Caption as="p">
        Snapshots per build counts cache hits, over builds that hold a snapshot. Time per snapshot
        is the server's compares with a stored time, no cache hit in it; a CI build's times are not
        in it, since reading them would mean reading every build of the window.
      </Caption>
    </Stack>
  );
}

export function BuildComparesTable({
  rows,
  total,
  testId,
}: {
  rows: BuildCompares[];
  /** How many builds the list was cut from. */
  total: number;
  testId: string;
}) {
  if (rows.length === 0) return null;
  const cut =
    total > rows.length
      ? ` Shown: ${formatNumber(rows.length)} of ${formatNumber(total)} builds.`
      : "";
  return (
    <>
      <Table variant="plain" caption="Compare times per build" data-testid={testId}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Build</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell align="end">Snapshots</TableHeaderCell>
            <TableHeaderCell align="end">Compared</TableHeaderCell>
            <TableHeaderCell align="end">p50</TableHeaderCell>
            <TableHeaderCell align="end">p95</TableHeaderCell>
            <TableHeaderCell align="end">p99</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((b) => (
            <TableRow key={b.id} data-testid={`${testId}-row`}>
              <TableCell mono>{b.id.slice(0, 8)}</TableCell>
              <TableCell>{b.status}</TableCell>
              <TableCell numeric align="end">
                {formatNumber(b.snapshots)}
              </TableCell>
              <TableCell numeric align="end">
                {formatNumber(b.compared)}
              </TableCell>
              <Times build={b} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Caption as="p">
        A cache hit has the same bytes as its baseline: it is a snapshot, no compare ran, and it is
        in no time. n counts the compares with a time: the server's, or else what the CLI sent. p95
        reads max under {P95_MIN_BUILDS} and p99 reads — under {formatNumber(P99_MIN_COMPARES)}.
        {cut}
      </Caption>
    </>
  );
}
