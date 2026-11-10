import {
  Caption,
  KeyValue,
  KeyValueList,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
} from "@hackcove/ui-react";
import type { OperatorHealth, WindowHealth } from "#/db/admin-health";
import { formatBytes, formatDateTime, formatNumber } from "#/lib/format";
import { P95_MIN_BUILDS, P99_MIN_BUILDS } from "#/lib/timings";
import { BuildComparesTable, WindowFiguresLine } from "./operator-compares";
import { NowSection } from "./operator-health-now";
import { Figure, HealthSection, StepCell, plural } from "./operator-health-parts";

/**
 * The operator's health page body (PS-330). Read-only: no control, no badge, no verdict. Every group
 * names its window and the `n` behind it, and a figure that could not be read says why in place of a number.
 */

function WindowSection({
  window: w,
  capped,
  summaryFailures,
}: {
  window: WindowHealth;
  capped: boolean;
  summaryFailures: OperatorHealth["summaryFailures"];
}) {
  const o = w.outcomes;
  return (
    <HealthSection
      title={w.label}
      note={`Builds that ended since ${formatDateTime(w.since)}${capped ? ", the newest only (the read is capped)" : ""}. Times are median / 95th percentile / 99th percentile. The middle figure is the slowest when under ${P95_MIN_BUILDS} builds; the last reads n/a when under ${P99_MIN_BUILDS}. Each cell names its own n.`}
      testId={`admin-window-${w.key}`}
    >
      <Text as="p" data-testid={`admin-${w.key}-finished`}>
        {plural(w.finished, "build")} finished
        {w.finished > 0 &&
          `: ${formatNumber(o.passed)} passed, ${formatNumber(o.changes)} changes, ${formatNumber(o.failed)} failed, ${formatNumber(o.errored)} errored.`}
        {w.finished === 0 && "."}
      </Text>
      {w.errored.length > 0 && (
        <Table variant="plain" caption="Errored builds by reason">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Errored, by the first words of the error</TableHeaderCell>
              <TableHeaderCell align="end">Builds</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {w.errored.map((e) => (
              <TableRow key={e.reason} data-testid={`admin-${w.key}-error`}>
                <TableCell>{e.reason}</TableCell>
                <TableCell numeric align="end">
                  {formatNumber(e.count)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Table variant="plain" caption="Step times">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Wall time</TableHeaderCell>
            <TableHeaderCell>Queue wait</TableHeaderCell>
            <TableHeaderCell>Diff</TableHeaderCell>
            <TableHeaderCell>Explain</TableHeaderCell>
            <TableHeaderCell>Summary</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow data-testid={`admin-${w.key}-times`}>
            <StepCell stats={w.wall} />
            <StepCell stats={w.queue} />
            <StepCell stats={w.diff} />
            <StepCell stats={w.explain} />
            <StepCell stats={w.summary} />
          </TableRow>
        </TableBody>
      </Table>
      <Caption as="p">
        Wall time is finished minus created. {plural(w.rerun, "build")} ran more than once and{" "}
        {w.rerun === 1 ? "is" : "are"} left out of the times.
      </Caption>
      <Text as="p" data-testid={`admin-${w.key}-compares`}>
        {plural(w.snapshots, "snapshot")} · {formatNumber(w.comparesRun)} compared ·{" "}
        {plural(w.cacheHits, "cache hit")}; {plural(w.explainFailures, "model explanation")} failed.
        Failed summary calls:{" "}
        <Figure reading={summaryFailures} testId={`admin-${w.key}-summary-failures`}>
          {(v) => formatNumber(v)}
        </Figure>
      </Text>
      <WindowFiguresLine figures={w.figures} testId={`admin-${w.key}-figures`} />
      <BuildComparesTable rows={w.builds} total={w.finished} testId={`admin-${w.key}-builds`} />
    </HealthSection>
  );
}

function DeploymentSection({ health }: { health: OperatorHealth }) {
  const d = health.deployment;
  return (
    <HealthSection
      title="Deployment"
      note="What this Worker instance is running, against the migrations the database has applied."
      testId="admin-deployment"
    >
      <KeyValueList>
        <KeyValue label="Release commit">
          <Figure reading={d.sha} testId="admin-sha">
            {(v) => v}
          </Figure>
        </KeyValue>
        <KeyValue label="Newest migration the database reports">
          <Figure reading={d.latestApplied} testId="admin-latest-migration">
            {(v) => v}
          </Figure>
        </KeyValue>
        <KeyValue label="Migrations the code carries that the database has not applied">
          <Figure reading={d.unapplied} testId="admin-unapplied">
            {(v) => (v.length === 0 ? "none" : v.join(", "))}
          </Figure>
        </KeyValue>
      </KeyValueList>
    </HealthSection>
  );
}

function StorageSection({ health }: { health: OperatorHealth }) {
  const s = health.storage;
  return (
    <HealthSection
      title="Storage"
      note="Row counts are every row, smoke runs included. Sizes come from the bindings, never an estimate."
      testId="admin-storage"
    >
      <Table variant="plain" caption="Row counts">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Table</TableHeaderCell>
            <TableHeaderCell align="end">Rows</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {s.rows.map((r) => (
            <TableRow key={r.table} data-testid={`admin-rows-${r.table}`}>
              <TableCell>{r.table}</TableCell>
              <TableCell numeric align="end">
                {formatNumber(r.count)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <KeyValueList align="start">
        <KeyValue label="Database size">
          <Figure reading={s.dbBytes} testId="admin-db-bytes">
            {formatBytes}
          </Figure>
        </KeyValue>
        <KeyValue label="Blob store (R2)">
          <Figure reading={s.r2} testId="admin-r2">
            {(v) => `${plural(v.objects, "object")}, ${formatBytes(v.bytes)}`}
          </Figure>
        </KeyValue>
      </KeyValueList>
    </HealthSection>
  );
}

export function OperatorHealthView({ health }: { health: OperatorHealth }) {
  return (
    <Stack data-testid="operator-health">
      <NowSection health={health} />
      {health.windows.map((w) => (
        <WindowSection
          key={w.key}
          window={w}
          capped={health.windowsCapped}
          summaryFailures={health.summaryFailures}
        />
      ))}
      <DeploymentSection health={health} />
      <StorageSection health={health} />
    </Stack>
  );
}
