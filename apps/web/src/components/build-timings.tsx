import { Body, Card, Cluster, KeyValue, KeyValueList, Overline, Stack } from "@hackcove/ui";
import type { BuildView } from "#/db/review";
import { formatDuration } from "#/lib/format";
import { type CardLine, NO_TIMINGS, type RunCardInput, runCard } from "#/lib/run-card";
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

function Figure({ line }: { line: CardLine }) {
  return (
    <KeyValue label={line.label} data-testid={`run-${line.key}`}>
      <Cluster gap="sm" align="baseline" wrap>
        <Body mono numeric data-testid={`run-${line.key}-value`}>
          {line.value}
        </Body>
        {line.note && <Body tone="muted">{line.note}</Body>}
        <Body tone="muted" data-testid={`run-${line.key}-source`}>
          ({line.source})
        </Body>
      </Cluster>
    </KeyValue>
  );
}

/**
 * The build page's "This run" card (PS-233): the wall time and the server's and CLI's steps, the
 * build's counts, its per-compare time and the model's tokens. When no timing was recorded it says
 * so in a sentence; a figure nobody recorded is left out, never shown as 0.
 */
export function BuildTimings(input: RunCardInput & { build: BuildView["build"] }) {
  const { build } = input;
  const card = runCard(input);
  const server = serverStepRows(build, build.aiSummary !== null);
  const cli = cliStepRows(build.timings);
  const timed = card.wall || card.compare || server.length > 0 || cli.length > 0;
  return (
    <Card size="sm" aria-label="This run" data-testid="build-timings">
      <Stack gap="sm">
        <Overline as="h2" tone="muted">
          This run
        </Overline>
        {!timed && (
          <Body as="p" tone="muted" data-testid="run-no-timings">
            {NO_TIMINGS}
          </Body>
        )}
        <KeyValueList align="start">
          {card.wall && <Figure line={card.wall} />}
          <Line scope="server" steps={server} note={build.rerun ? RERUN_NOTE : undefined} />
          <Line
            scope="cli"
            steps={cli}
            note={cli.some((step) => step.key === "total") ? CLI_TOTAL_NOTE : undefined}
          />
          {card.counts.map((line) => (
            <Figure key={line.key} line={line} />
          ))}
          {card.compare && <Figure line={card.compare} />}
          {card.tokens.map((line) => (
            <Figure key={line.key} line={line} />
          ))}
        </KeyValueList>
      </Stack>
    </Card>
  );
}
