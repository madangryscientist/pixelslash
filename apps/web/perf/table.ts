/** Prints perf/results/<run>/*.json as the README's tables: `bun perf/table.ts perf/results/<run>`. */
import { readFileSync, readdirSync } from "node:fs";

type Phase = {
  phase: string;
  seconds: number;
  note?: string;
  peakMB: Record<string, number>;
  hwmMB: Record<string, number>;
  endMB: Record<string, number>;
  webUnitPeakMB: number;
  webUnitSwapPeakMB: number;
  webUnitAnonPeakMB?: number;
  webUnitFilePeakMB?: number;
  webHighEvents: number;
  diffUnitPeakMB: number;
};
type Run = {
  shots: number;
  uploadMB: { main: number; branch: number };
  idle: Record<string, number>;
  phases: Phase[];
  probes: { count: number; failed: number; slowestMs: number };
};

const dir = process.argv[2] ?? "";
const runs = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f): Run => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))
  .toSorted((a, b) => a.shots - b.shots);

const mb = (n: number | undefined) => `${Math.round(n ?? 0)}`;
const out: string[] = [];
out.push(
  "| shots | phase | s | workerd | vite | serve.ts | sidecar | web unit (cgroup) | anon / file | swap | `high` events | note |",
  "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
);
for (const run of runs) {
  out.push(
    `| ${run.shots} | idle (cold start) | | ${mb(run.idle["workerd"])} | ${mb(run.idle["vite"])} | ${mb(run.idle["host"])} | ${mb(run.idle["sidecar"])} | | | | | | |`,
  );
  for (const p of run.phases)
    out.push(
      `| ${run.shots} | ${p.phase} | ${p.seconds.toFixed(0)} | ${mb(p.hwmMB["workerd"])} | ${mb(p.hwmMB["vite"])} | ${mb(p.hwmMB["host"])} | ${mb(p.hwmMB["sidecar"])} | ${mb(p.webUnitPeakMB)} | ${p.webUnitAnonPeakMB === undefined ? "" : `${mb(p.webUnitAnonPeakMB)} / ${mb(p.webUnitFilePeakMB)}`} | ${mb(p.webUnitSwapPeakMB)} | ${p.webHighEvents} | ${p.note ?? ""} |`,
    );
}
out.push(
  "",
  "| shots | main / branch upload MB | `GET /` probes (failed, slowest) |",
  "| ---: | ---: | --- |",
);
for (const run of runs)
  out.push(
    `| ${run.shots} | ${run.uploadMB.main.toFixed(0)} / ${run.uploadMB.branch.toFixed(0)} | ${run.probes.count} (${run.probes.failed}, ${run.probes.slowestMs} ms) |`,
  );
process.stdout.write(out.join("\n") + "\n");
