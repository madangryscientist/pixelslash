import { Body, Card, Cluster, KeyValue, KeyValueList } from "@hackcove/ui";
import type { BuildView } from "#/db/review";
import { formatDuration } from "#/lib/format";
import {
  CLI_TOTAL_NOTE,
  RERUN_NOTE,
  type StepRow,
  cliStepRows,
  serverStepRows,
} from "#/lib/timings";

/**
 * How long a build took (ob 1792): the server's steps, from the numbers its diff run and the
 * explain queue stored, and the CLI's (ob 1791) when it sent them. A step that did not run, or has
 * not finished, is not shown rather than shown as 0.
 */

function Line({
  scope,
  steps,
  note,
}: {
  scope: "server" | "cli";
  steps: StepRow[];
  note?: string | undefined;
}) {
  if (steps.length === 0) return null;
  return (
    <KeyValue label={scope === "cli" ? "CLI" : "Server"} data-testid={`timings-${scope}`}>
      <Cluster gap="sm" align="baseline" wrap>
        {steps.map((step) => (
          <span key={step.key} data-testid={`timing-${scope}-${step.key}`}>
            <Body tone="muted">{step.label}</Body>{" "}
            <Body mono numeric>
              {formatDuration(step.ms)}
            </Body>
            {step.note && (
              <Body tone="muted" data-testid={`timing-${scope}-${step.key}-note`}>
                {" "}
                ({step.note})
              </Body>
            )}
          </span>
        ))}
        {note && (
          <Body tone="muted" data-testid={`timings-${scope}-note`}>
            {note}
          </Body>
        )}
      </Cluster>
    </KeyValue>
  );
}

export function BuildTimings({ build }: { build: BuildView["build"] }) {
  const server = serverStepRows(build, build.aiSummary !== null);
  const cli = cliStepRows(build.timings);
  if (server.length === 0 && cli.length === 0) return null;
  return (
    <Card size="sm" aria-label="Timings" data-testid="build-timings">
      <KeyValueList align="start">
        <Line scope="server" steps={server} note={build.rerun ? RERUN_NOTE : undefined} />
        <Line
          scope="cli"
          steps={cli}
          note={cli.some((step) => step.key === "total") ? CLI_TOTAL_NOTE : undefined}
        />
      </KeyValueList>
    </Card>
  );
}
