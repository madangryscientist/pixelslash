import {
  Caption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@hackcove/ui-react";
import type { BuildCompares } from "#/db/build-compares";
import { formatDuration, formatNumber } from "#/lib/format";
import { P95_MIN_BUILDS, P99_MIN_COMPARES } from "#/lib/timings";

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
