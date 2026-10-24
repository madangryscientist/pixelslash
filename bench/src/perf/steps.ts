/** The timed steps of `bun run bench:perf` (ob 1790). */

export const STEP_IDS = [
  "diff-phone",
  "diff-desktop",
  "diff-long",
  "diff-identical",
  "capture",
  "server-build",
] as const;
/** The steps an outside implementation of the diff contract can be timed on (ob 1909). */
export const IMPL_STEP_IDS = ["diff-phone", "diff-desktop", "diff-long"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  "diff-phone": "diff + regions, phone 390x844",
  "diff-desktop": "diff + regions, desktop 1440x900",
  "diff-long": "diff + regions, long page 1440x6000",
  "diff-identical": "identical pair, long page 1440x6000, same file twice",
  capture: "capture, local static page",
  "server-build": "server build, 10 shots, start to verdict",
};

/** What one `probe.ts` process prints: every step's timings in ms, warm-up already dropped. */
export type ProbeResult = Partial<Record<StepId, number[]>>;

export function isStep(id: string): id is StepId {
  return STEP_IDS.some((s) => s === id);
}

const isTimings = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number");

/** Read the JSON line a probe printed; a step that is not a list of numbers is an error. */
export function parseProbe(text: string): ProbeResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("probe printed no object");
  const result: ProbeResult = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isStep(key) || !isTimings(value)) throw new Error(`probe printed a bad entry: ${key}`);
    result[key] = value;
  }
  return result;
}
