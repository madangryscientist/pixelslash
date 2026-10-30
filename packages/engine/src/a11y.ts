import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { withTimeout } from "./capture.ts";
import { CaptureError } from "./errors.ts";
import {
  IMPACTS,
  MAX_TEXT,
  MAX_VIOLATIONS,
  type A11y,
  type A11yViolation,
  type Impact,
} from "./a11y-entry.ts";

/** The longest a scan may take; a page whose scan does not finish fails the capture, it is not called clean. */
export const SCAN_TIMEOUT_MS = 20_000;

/** The WCAG 2.0 to 2.2 A and AA rules. axe's `best-practice` rules are opinions, not conformance, and are left off. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type RawViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
};

declare const axe: {
  run(
    context: unknown,
    options: { runOnly: { type: "tag"; values: string[] }; resultTypes: string[] },
  ): Promise<{ violations: RawViolation[] }>;
};
declare const document: unknown;

let source: Promise<string> | undefined;

/** axe-core's minified build, unmodified, read once from the installed package. */
function axeSource(): Promise<string> {
  source ??= Bun.file(fileURLToPath(import.meta.resolve("axe-core/axe.min.js"))).text();
  return source;
}

/** A frame or shadow-root hop is an array in axe's target; the path reads left to right with ` >> `. */
function selectorOf(target: unknown[]): string {
  return target.map((t) => (Array.isArray(t) ? t.join(" >> ") : String(t))).join(" >> ");
}

const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const impactOf = (v: string | null | undefined): Impact | null =>
  IMPACTS.find((i) => i === v) ?? null;

/** One entry per failing element, in axe's order (rule, then document order), capped at `MAX_VIOLATIONS`. */
export function flatten(raw: RawViolation[]): A11y {
  const all = raw.flatMap((r) =>
    r.nodes.map((n): A11yViolation => ({
      rule: r.id,
      impact: impactOf(r.impact),
      help: cut(r.help),
      selector: cut(selectorOf(n.target)),
    })),
  );
  const violations = all.slice(0, MAX_VIOLATIONS);
  return all.length > MAX_VIOLATIONS
    ? { violations, omitted: all.length - MAX_VIOLATIONS }
    : { violations };
}

/**
 * Scan the settled page with axe-core and return the WCAG A and AA violations. Run after the
 * screenshot: the scan reads the DOM and changes nothing a shot can see. axe is evaluated through
 * the protocol, not injected as a script tag, so a page's Content-Security-Policy cannot block it.
 * Nothing leaves the machine: axe runs in the page and reports to this process.
 */
export async function scanA11y(page: Page, timeoutMs = SCAN_TIMEOUT_MS): Promise<A11y> {
  try {
    const raw = await withTimeout(
      (async () => {
        await page.evaluate(await axeSource());
        return page.evaluate(async (tags) => {
          const result = await axe.run(document, {
            runOnly: { type: "tag", values: tags },
            resultTypes: ["violations"],
          });
          return result.violations.map((v) => ({
            id: v.id,
            impact: v.impact ?? null,
            help: v.help,
            nodes: v.nodes.map((n) => ({ target: n.target })),
          }));
        }, WCAG_TAGS);
      })(),
      timeoutMs,
      `accessibility scan exceeded ${timeoutMs}ms`,
    );
    return flatten(raw);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError(
      `accessibility scan failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
