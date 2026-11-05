import {
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
} from "@hackcove/ui-react";
import type { OperatorHealth } from "#/db/admin-health";
import { formatDateTime, formatDuration, formatNumber } from "#/lib/format";
import { BuildComparesTable } from "./operator-compares";
import { HealthSection, plural } from "./operator-health-parts";

/** The "Now" group of the operator health page (PS-330): every build, what is in flight, what is stuck. */

type Now = OperatorHealth["now"];

function StatusTable({ byStatus }: { byStatus: Now["byStatus"] }) {
  const statuses = Object.entries(byStatus).toSorted(([a], [b]) => a.localeCompare(b));
  if (statuses.length === 0)
    return (
      <Text as="p" tone="muted" data-testid="admin-no-builds">
        No builds yet.
      </Text>
    );
  return (
    <Table variant="plain" caption="Builds by status">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="end">Builds</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {statuses.map(([status, n]) => (
          <TableRow key={status} data-testid={`admin-status-${status}`}>
            <TableCell>{status}</TableCell>
            <TableCell mono align="end">
              {formatNumber(n)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Oldest({ now }: { now: Now }) {
  const oldest = now.oldestInFlight;
  if (!oldest)
    return (
      <Text as="p" data-testid="admin-oldest">
        Nothing in flight.
      </Text>
    );
  return (
    <Text as="p" data-testid="admin-oldest">
      {`Oldest in flight: build ${oldest.id.slice(0, 8)}, ${formatDuration(oldest.ageMs)} old, ${oldest.status}, of ${plural(now.inFlight, "build")} in flight.`}
    </Text>
  );
}

function stuckLine(now: Now): string {
  const after = formatDuration(now.stuckAfterMs);
  if (now.stuckTotal === 0) return `No build has been processing for more than ${after}.`;
  const listed =
    now.stuck.length < now.stuckTotal
      ? `; the longest ${formatNumber(now.stuck.length)} are listed`
      : "";
  return `${plural(now.stuckTotal, "build")} processing for more than ${after}${listed}.`;
}

function StuckTable({ stuck }: { stuck: Now["stuck"] }) {
  if (stuck.length === 0) return null;
  return (
    <Table variant="plain" caption="Stuck builds">
      <TableHead>
        <TableRow>
          <TableHeaderCell>Build</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell align="end">Stuck for</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {stuck.map((b) => (
          <TableRow key={b.id} data-testid="admin-stuck-row">
            <TableCell mono>{b.id.slice(0, 8)}</TableCell>
            <TableCell>{formatDateTime(b.createdAt)}</TableCell>
            <TableCell mono align="end">
              {formatDuration(b.stuckMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function NowSection({ health }: { health: OperatorHealth }) {
  const { now, asOf } = health;
  return (
    <HealthSection
      title="Now"
      note={`Every build, as of ${formatDateTime(asOf)}. In flight is uploading or processing.`}
      testId="admin-now"
    >
      <StatusTable byStatus={now.byStatus} />
      <Oldest now={now} />
      {now.flying.length > 0 && (
        <BuildComparesTable rows={now.flying} total={now.inFlight} testId="admin-now-builds" />
      )}
      <Stack gap="xs">
        <Text as="p" data-testid="admin-stuck-count">
          {stuckLine(now)}
        </Text>
        <StuckTable stuck={now.stuck} />
      </Stack>
    </HealthSection>
  );
}
