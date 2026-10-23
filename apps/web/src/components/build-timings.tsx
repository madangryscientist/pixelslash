import type { BuildTimings as CliTimings } from "#/db/diff-json";
import type { BuildView } from "#/db/review";
import { formatDuration } from "#/lib/format";
import { totalMs } from "#/lib/timings";

/**
 * How long a build took (ob 1792): the server's steps, from the numbers its diff run and the
 * explain queue stored, and the CLI's (ob 1791) when it sent them. A step that did not run, or has
 * not finished, is not shown rather than shown as 0.
 */

type Step = { key: string; label: string; ms: number };

function serverSteps(build: BuildView["build"]): Step[] {
  const all: [string, string, number | null][] = [
    ["queue", "before diff", build.queueMs],
    ["diff", "diff", build.diffMs],
    ["explain", "AI explanations", build.explainMs],
    ["summary", "AI summary", build.summaryMs],
    ["total", "total", totalMs(build)],
  ];
  return all.flatMap(([key, label, ms]) => (ms === null ? [] : [{ key, label, ms }]));
}

function cliSteps(timings: CliTimings | null): Step[] {
  if (!timings) return [];
  const all: [string, string, number | undefined][] = [
    ["capture", "capture", timings.captureMs],
    ["diff", "diff", timings.diffMs],
    ["judge", "judge", timings.judgeMs],
    ["upload", "upload", timings.upload?.totalMs],
    ["total", "total", timings.totalMs],
  ];
  return all.flatMap(([key, label, ms]) => (ms === undefined ? [] : [{ key, label, ms }]));
}

function Line({
  scope,
  steps,
  note,
}: {
  scope: "server" | "cli";
  steps: Step[];
  note?: string | undefined;
}) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1" data-testid={`timings-${scope}`}>
      <span className="w-14 font-medium text-slate-700">{scope === "cli" ? "CLI" : "Server"}</span>
      {steps.map((step) => (
        <span key={step.key} data-testid={`timing-${scope}-${step.key}`}>
          <span className="text-slate-500">{step.label}</span>{" "}
          <span className="font-mono text-slate-800">{formatDuration(step.ms)}</span>
        </span>
      ))}
      {note && <span className="text-slate-500">{note}</span>}
    </div>
  );
}

export function BuildTimings({ build }: { build: BuildView["build"] }) {
  const server = serverSteps(build);
  const cli = cliSteps(build.timings);
  if (server.length === 0 && cli.length === 0) return null;
  return (
    <section
      aria-label="Timings"
      data-testid="build-timings"
      className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm"
    >
      <Line
        scope="server"
        steps={server}
        note={build.rerun ? "of the latest run, a re-run of this build" : undefined}
      />
      <Line scope="cli" steps={cli} />
    </section>
  );
}
