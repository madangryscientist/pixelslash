/**
 * Argos, driven only through the wrapper that ops/argos-bench/ already provides (ob 1476): pairs go
 * out over ssh to the argos-bench VM and verdicts and diff images come back. The VM address and key
 * come from ARGOS_BENCH_HOST / ARGOS_BENCH_KEY, the same variables run-pairs.sh reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { BENCH_DIR, isRecord } from "./corpus.ts";
import { extractRegions, maskFromRgba } from "./regions.ts";
import type { ToolResult } from "./types.ts";

const RUN_PAIRS = join(BENCH_DIR, "..", "ops", "argos-bench", "run-pairs.sh");

export const argosHost = () => process.env["ARGOS_BENCH_HOST"] ?? "debian@192.168.0.45";
export const argosKey = () =>
  process.env["ARGOS_BENCH_KEY"] ?? join(process.env["HOME"] ?? "", ".ssh", "id_ed25519_mac");

type Verdict = {
  name: string;
  changed: boolean;
  score: number;
  ms: number | null;
  diff: string | null;
};

function parseVerdict(line: string): Verdict {
  const raw: unknown = JSON.parse(line);
  if (!isRecord(raw)) throw new Error(`bad verdict line: ${line}`);
  const { name, changed, score, ms, diff } = raw;
  if (typeof name !== "string" || typeof changed !== "boolean" || typeof score !== "number")
    throw new Error(`bad verdict line: ${line}`);
  return {
    name,
    changed,
    score,
    ms: typeof ms === "number" ? ms : null,
    diff: typeof diff === "string" ? diff : null,
  };
}

/** Run every `<name>/{base,head}.png` under `pairsDir` through Argos; `outDir` receives its diff images. */
export async function runArgos(
  pairsDir: string,
  outDir: string,
  threshold?: number,
): Promise<{ results: Map<string, ToolResult>; wallMs: number }> {
  const args = ["bash", RUN_PAIRS, pairsDir, outDir];
  if (threshold !== undefined) args.push("--threshold", String(threshold));
  const started = performance.now();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const wallMs = performance.now() - started;
  if (code !== 0) {
    throw new Error(
      `Argos run failed (exit ${code}) on ${argosHost()}:\n${stderr.trim()}\n` +
        "Is VM 101 up? `ssh root@192.168.0.20 'qm start 101'`; set ARGOS_BENCH_HOST if its address changed. See ops/argos-bench/runbook.md.",
    );
  }
  const results = new Map<string, ToolResult>();
  for (const line of stdout.split("\n").filter((l) => l.trim() !== "")) {
    const v = parseVerdict(line);
    let regions: ToolResult["regions"] = [];
    let diffPng: Buffer | null = null;
    if (v.diff) {
      diffPng = readFileSync(v.diff);
      const mask = PNG.sync.read(diffPng);
      regions = extractRegions(maskFromRgba(mask.width, mask.height, mask.data));
    }
    results.set(v.name, {
      changed: v.changed,
      regions,
      ms: v.ms,
      note: `score ${Number(v.score.toPrecision(3))}`,
      diffPng,
      sizeMismatch: false,
    });
  }
  return { results, wallMs };
}
