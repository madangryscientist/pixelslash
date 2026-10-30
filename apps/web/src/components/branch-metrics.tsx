import { Card, Cluster, KeyValue, KeyValueList, Overline, Stack, Text } from "@hackcove/ui";
import { type BranchMetrics as Metrics, sparkPoints } from "#/lib/branch-metrics";
import { formatDuration, formatNumber } from "#/lib/format";
import { statsText } from "#/lib/run-card";

/**
 * The branch page's metrics (PS-233) over its last builds: wall time, compares and per-compare
 * time, each with the `n` behind it, and a sparkline of wall time once there are three points.
 * Everything is derived from times and shots the server stored.
 */

const WIDTH = 120;
const HEIGHT = 24;

const builds = (n: number) => `${formatNumber(n)} build${n === 1 ? "" : "s"}`;

function Trend({ trend }: { trend: Metrics["trend"] }) {
  if (trend.length < 2) return null;
  if (trend.length === 2)
    return (
      <Text mono numeric data-testid="branch-metrics-pair">
        {trend.map((p) => formatDuration(p.ms)).join(" → ")}
      </Text>
    );
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`-1 -1 ${WIDTH + 2} ${HEIGHT + 2}`}
      role="img"
      aria-label={`Build wall time over the last ${trend.length} finished builds, oldest first`}
      data-testid="branch-metrics-sparkline"
    >
      <polyline
        points={sparkPoints(trend, WIDTH, HEIGHT)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BranchMetrics({ metrics }: { metrics: Metrics }) {
  const { wall, compareTime } = metrics;
  return (
    <Card size="sm" aria-label="Branch metrics" data-testid="branch-metrics">
      <Stack gap="sm">
        <Overline as="h2" tone="muted">
          Last {metrics.window} builds
        </Overline>
        <Text as="p" tone="muted" data-testid="branch-metrics-window">
          {`Over the branch's last ${metrics.window} builds: ${builds(metrics.builds)} here. Derived from times and shots the server stored.`}
        </Text>
        <KeyValueList align="start">
          <KeyValue label="Builds">
            <span data-testid="branch-metrics-builds">{formatNumber(metrics.builds)}</span>
          </KeyValue>
          {wall && (
            <KeyValue label="Build wall time">
              <Cluster gap="sm" align="baseline" wrap>
                <Text mono numeric data-testid="branch-metrics-wall">
                  {statsText(wall, wall.n === 1 ? "finished build" : "finished builds")}
                </Text>
                <Trend trend={metrics.trend} />
              </Cluster>
            </KeyValue>
          )}
          <KeyValue label="Compares">
            <span data-testid="branch-metrics-compares">{`${formatNumber(metrics.compares)} over ${builds(metrics.builds)}`}</span>
          </KeyValue>
          {compareTime && (
            <KeyValue label="Per-compare time">
              <Text mono numeric data-testid="branch-metrics-compare-time">
                {statsText(compareTime, compareTime.n === 1 ? "shot" : "shots")}
              </Text>
            </KeyValue>
          )}
        </KeyValueList>
      </Stack>
    </Card>
  );
}
