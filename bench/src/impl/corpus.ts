/** Score an outside implementation on the corpora (ob 1909): the same `ToolResult` the in-process engine gives. */
import { join } from "node:path";
import { caseKey, type CorpusCase } from "../corpus.ts";
import type { ToolResult } from "../types.ts";
import { DEFAULT_TIMEOUT_MS, describeFailure, invokeImpl, type ImplFailure } from "./invoke.ts";

type CaseFailure = { key: string; failure: ImplFailure };

/**
 * Every case through `<command> diff base head --json`, one process at a time. A case the
 * implementation could not answer is a named failure and has no result; the others still score.
 * `ms` is the implementation's own `decode_ms + diff_ms`, so process start-up is not counted.
 */
export async function runImplCorpus(
  command: string,
  cases: CorpusCase[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ results: Map<string, ToolResult>; failures: CaseFailure[] }> {
  const results = new Map<string, ToolResult>();
  const failures: CaseFailure[] = [];
  for (const c of cases) {
    const key = caseKey(c);
    const run = await invokeImpl(command, join(c.dir, "base.png"), join(c.dir, "head.png"), {
      timeoutMs,
    });
    if (!run.ok) {
      failures.push({ key, failure: run.failure });
      continue;
    }
    const { verdict, regions, decode_ms, diff_ms } = run.output;
    results.set(key, {
      changed: verdict === "changed",
      regions,
      ms: decode_ms + diff_ms,
      note: `${regions.length} region${regions.length === 1 ? "" : "s"}`,
      diffPng: null,
      // The size-mismatch note in the tables explains PixelSlash's overlap rule, not an outside engine's.
      sizeMismatch: false,
    });
  }
  return { results, failures };
}

export const failureLines = (failures: CaseFailure[]): string =>
  failures.map((f) => `  ${f.key}: ${describeFailure(f.failure)}`).join("\n");
