/**
 * Proves which commit a deployed page was built from:
 *
 *   bun scripts/check-commit.ts <page url> <sha>
 *
 * Fetches the page (with a random `commit-check` query, so no cache answers for it), reads its
 * `<meta name="build-commit">` (apps/web/build-commit.ts) and exits 0 when it equals the sha. A
 * page that is down, has no meta or names another commit is fetched again, every few seconds for up
 * to two minutes, since an edge can serve the old Worker for a moment after a deploy; then it exits
 * 1, printing what it saw last. A redirect fails at once, naming where it points: the check is of
 * that page, not of wherever it sends a visitor.
 */

interface CheckResult {
  ok: boolean;
  /** What the page said last: its sha, or why there was none. */
  seen: string;
}

interface CheckOptions {
  timeoutMs?: number;
  intervalMs?: number;
  log?: (line: string) => void;
}

const META = /<meta\s[^>]*>/gi;
const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1];

/** Every `build-commit` meta's content in the page's HTML. */
export function buildCommitsIn(html: string): string[] {
  return [...html.matchAll(META)]
    .map((match) => match[0])
    .filter((tag) => attr(tag, "name") === "build-commit")
    .map((tag) => attr(tag, "content") ?? "");
}

type Attempt = { kind: "done"; result: CheckResult } | { kind: "retry"; seen: string };

async function attempt(pageUrl: string, sha: string): Promise<Attempt> {
  const url = new URL(pageUrl);
  url.searchParams.set("commit-check", crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch(url, { redirect: "manual", headers: { "cache-control": "no-cache" } });
  } catch (error) {
    return { kind: "retry", seen: `no answer (${String(error)})` };
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "(no Location header)";
    return {
      kind: "done",
      result: { ok: false, seen: `a ${response.status} redirect to ${location}` },
    };
  }
  if (!response.ok) return { kind: "retry", seen: `HTTP ${response.status}` };
  const found = buildCommitsIn(await response.text());
  if (found.length === 0) return { kind: "retry", seen: "no build-commit meta" };
  if (found.length > 1) return { kind: "retry", seen: `${found.length} build-commit metas` };
  const [seen = ""] = found;
  return seen === sha ? { kind: "done", result: { ok: true, seen } } : { kind: "retry", seen };
}

export async function checkCommit(
  pageUrl: string,
  sha: string,
  { timeoutMs = 120_000, intervalMs = 5_000, log = () => {} }: CheckOptions = {},
): Promise<CheckResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = await attempt(pageUrl, sha);
    if (next.kind === "done") return next.result;
    if (Date.now() + intervalMs > deadline) return { ok: false, seen: next.seen };
    log(`${pageUrl}: ${next.seen}, not ${sha}; trying again`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.main) {
  const [pageUrl, sha] = process.argv.slice(2);
  if (!pageUrl || !sha) {
    console.error("usage: bun scripts/check-commit.ts <page url> <sha>");
    process.exit(2);
  }
  const result = await checkCommit(pageUrl, sha, { log: (line) => console.error(line) });
  if (result.ok) {
    console.log(`ok: ${pageUrl} is at ${result.seen}`);
  } else {
    console.error(`FAILED: ${pageUrl} is at ${result.seen}, expected ${sha}`);
    process.exit(1);
  }
}
