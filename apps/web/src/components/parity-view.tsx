import { Caption, Callout, Card, Overline, Stack, Text, TextLink } from "@hackcove/ui-react";
import { Link } from "@tanstack/react-router";
import { StaleBadge } from "#/components/stale";
import {
  NOT_MEASURED,
  type ParityMetricsView,
  type ParityPairView,
  type ParityShotColumn,
  type ParityView,
  pairLabel,
  scaleText,
} from "#/lib/parity-view";
import { staleDate } from "#/lib/stale";
import { twinSourceLabel } from "#/lib/twins";

/**
 * The parity view of one snapshot key (PS-298): web, android and ios side by side at one physical
 * size, the metrics comparison under them, and a similarity hint per native column. The hint is
 * shown and nothing else: it is no status, check or count.
 */

function ShotLink({ column }: { column: ParityShotColumn }) {
  return (
    <TextLink
      data-testid="parity-shot-link"
      render={(p) => (
        <Link
          to="/projects/$projectId/builds/$buildId/snapshots/$snapshotId"
          params={{
            projectId: column.projectId,
            buildId: column.buildId,
            snapshotId: column.snapshotId,
          }}
          {...p}
        />
      )}
    >
      {column.label}
    </TextLink>
  );
}

/** A shot is drawn at its physical size: its pixels divided by its scale. */
function ShotColumn({ column }: { column: ParityShotColumn }) {
  const { physical } = column;
  return (
    <Stack gap="xs" data-testid="parity-column" data-platform={column.platform}>
      <Overline as="h3" tone="muted">
        {column.platform}
      </Overline>
      <Text as="p" strong>
        <ShotLink column={column} />
        {column.stale && (
          <>
            {" "}
            <StaleBadge />
          </>
        )}
      </Text>
      <Caption as="p" tone="muted" data-testid="parity-meta">
        {column.viewport} · scale {scaleText(column.scale)} · {twinSourceLabel(column.source)} ·{" "}
        {column.projectName}
      </Caption>
      {column.stale && (
        <Caption as="p" tone="muted" data-testid="parity-stale-cause">
          web changed, accepted by {column.stale.acceptedBy ?? "someone"}{" "}
          {staleDate(column.stale.acceptedAt)}
        </Caption>
      )}
      <img
        src={column.imageUrl}
        alt={`${column.label} shot`}
        data-testid="parity-image"
        style={physical ? { width: physical.width, maxWidth: "none" } : undefined}
        className="block h-auto border border-current/25"
      />
      {physical && (
        <Caption as="p" tone="muted" data-testid="parity-physical">
          {physical.width} × {physical.height} px at {scaleText(column.scale)}
        </Caption>
      )}
      {column.similarity && (
        <Caption as="p" tone="muted" data-testid="parity-similarity">
          {column.similarity.text}
        </Caption>
      )}
      {!column.hasMetrics && (
        <Caption as="p" tone="muted">
          {NOT_MEASURED}
        </Caption>
      )}
    </Stack>
  );
}

function Columns({ columns }: { columns: ParityView["columns"] }) {
  return (
    <div className="flex items-start gap-6 overflow-x-auto pb-2" data-testid="parity-columns">
      {columns.map((c) =>
        c.kind === "missing" ? (
          <Stack
            gap="xs"
            key={`missing:${c.platform}`}
            data-testid="parity-missing"
            data-platform={c.platform}
          >
            <Overline as="h3" tone="muted">
              {c.platform}
            </Overline>
            <Text as="p" tone="muted">
              {`no ${c.platform} twin`}
            </Text>
            <Caption as="p" tone="muted">
              {c.line}
            </Caption>
          </Stack>
        ) : (
          <ShotColumn key={c.snapshotId} column={c} />
        ),
      )}
    </div>
  );
}

function Pair({ pair }: { pair: ParityPairView }) {
  return (
    <li data-testid="parity-pair" data-status={pair.status}>
      <Stack gap="xs">
        <Text as="p" strong>
          {pairLabel(pair)}
        </Text>
        {pair.status === "not_measured" && (
          <Text as="p" tone="muted">
            {`${NOT_MEASURED}: no metrics file on ${pair.lacks.join(" or ")}`}
          </Text>
        )}
        {pair.status === "clean" && (
          <Text as="p" tone="muted">
            no mismatch
          </Text>
        )}
        {pair.mismatches.map((m) => (
          <Text as="p" key={m} data-testid="parity-mismatch">
            {m}
          </Text>
        ))}
        {pair.declared.length > 0 && (
          <Stack gap="xs" data-testid="parity-declared">
            <Caption as="p" tone="muted">
              Declared differences (not mismatches)
            </Caption>
            {pair.declared.map((d) => (
              <Text as="p" tone="muted" key={d}>
                {d}
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </li>
  );
}

function RawNumbers({ metrics }: { metrics: ParityMetricsView }) {
  if (metrics.raw.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="text-sm" data-testid="parity-raw">
        <caption className="pb-1 text-left">
          <Caption tone="muted">The numbers each shot measured</Caption>
        </caption>
        <thead>
          <tr>
            <th className="pr-4 text-left">Part</th>
            <th className="pr-4 text-left">Field</th>
            {metrics.rawColumns.map((c) => (
              <th key={c.snapshotId} className="pr-4 text-left">
                {c.label}
                {!c.measured && <> ({NOT_MEASURED})</>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.raw.map((r) => (
            <tr key={`${r.part}:${r.field}`}>
              <td className="pr-4">{r.part}</td>
              <td className="pr-4">{r.field}</td>
              {r.values.map((v, i) => (
                <td key={metrics.rawColumns[i]?.snapshotId ?? i} className="pr-4">
                  {v ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricsSection({ metrics }: { metrics: ParityMetricsView }) {
  return (
    <Stack as="section" gap="sm" data-testid="parity-metrics">
      <Overline as="h2" tone="muted">
        Metrics
      </Overline>
      {metrics.notice && (
        <Callout tone="info" data-testid="parity-manifest-notice">
          {metrics.notice}
        </Callout>
      )}
      {metrics.pairs.length === 0 ? (
        <Text as="p" tone="muted">
          Only one platform has a shot here: nothing to compare.
        </Text>
      ) : (
        <Stack as="ul" gap="sm">
          {metrics.pairs.map((p) => (
            <Pair key={`${p.a.snapshotId}:${p.b.snapshotId}`} pair={p} />
          ))}
        </Stack>
      )}
      <RawNumbers metrics={metrics} />
    </Stack>
  );
}

export function ParityBody({ view }: { view: ParityView }) {
  return (
    <Stack gap="lg" data-testid="parity">
      <Card>
        <Columns columns={view.columns} />
      </Card>
      <MetricsSection metrics={view.metrics} />
    </Stack>
  );
}
