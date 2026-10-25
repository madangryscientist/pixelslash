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
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1" data-testid={`timings-${scope}`}>
      <span className="w-14 font-medium text-slate-700">{scope === "cli" ? "CLI" : "Server"}</span>
      {steps.map((step) => (
        <span key={step.key} data-testid={`timing-${scope}-${step.key}`}>
          <span className="text-slate-500">{step.label}</span>{" "}
          <span className="font-mono text-slate-800 tabular-nums">{formatDuration(step.ms)}</span>
          {step.note && (
            <span data-testid={`timing-${scope}-${step.key}-note`} className="text-slate-500">
              {" "}
              ({step.note})
            </span>
          )}
        </span>
      ))}
      {note && (
        <span data-testid={`timings-${scope}-note`} className="text-slate-500">
          {note}
        </span>
      )}
    </div>
  );
}

export function BuildTimings({ build }: { build: BuildView["build"] }) {
  const server = serverStepRows(build, build.aiSummary !== null);
  const cli = cliStepRows(build.timings);
  if (server.length === 0 && cli.length === 0) return null;
  return (
    <section
      aria-label="Timings"
      data-testid="build-timings"
      className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
    >
      <Line scope="server" steps={server} note={build.rerun ? RERUN_NOTE : undefined} />
      <Line
        scope="cli"
        steps={cli}
        note={cli.some((step) => step.key === "total") ? CLI_TOTAL_NOTE : undefined}
      />
    </section>
  );
}
