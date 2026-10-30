import type { AiUsage } from "#/db/schema";

/**
 * Model tokens (PS-233): what a chat-completions reply says it spent, and the sum over the calls
 * whose answers were stored. Read from the reply's `usage`, never estimated.
 */

/** One reply's tokens; null when the endpoint did not report them. */
export type TokenUsage = { input: number; output: number; total: number };

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value ? Reflect.get(value, key) : null;

/**
 * The `usage` of a reply: its prompt and completion tokens, and its total, or their sum when it sent
 * none. Null when either count is missing: half a count is not a count.
 */
export function usageOf(body: unknown): TokenUsage | null {
  const usage = field(body, "usage");
  const input = count(field(usage, "prompt_tokens"));
  const output = count(field(usage, "completion_tokens"));
  if (input === null || output === null) return null;
  return { input, output, total: count(field(usage, "total_tokens")) ?? input + output };
}

/** The tokens of these calls: one entry per stored answer, null where the reply reported none. */
export function tally(usages: (TokenUsage | null)[]): AiUsage {
  const reported = usages.filter((u) => u !== null);
  const sum = (key: keyof TokenUsage) =>
    reported.length > 0 ? reported.reduce((n, u) => n + u[key], 0) : null;
  return {
    calls: usages.length,
    reported: reported.length,
    input: sum("input"),
    output: sum("output"),
    total: sum("total"),
  };
}
