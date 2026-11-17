import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCommitsIn, checkCommit } from "../check-commit.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const page = (meta: string) =>
  `<!DOCTYPE html><html><head><meta charSet="utf-8"/>${meta}<title>t</title></head><body></body></html>`;
const fast = { timeoutMs: 400, intervalMs: 20 };
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

describe("checkCommit", () => {
  // Each path answers in its own way; `/late` names the old sha for its first two requests.
  let server: ReturnType<typeof Bun.serve>;
  let lateHits = 0;
  const queries: string[] = [];
  const base = () => `http://127.0.0.1:${server.port}`;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        queries.push(url.searchParams.get("commit-check") ?? "");
        switch (url.pathname) {
          case "/match":
            return html(page(`<meta name="build-commit" content="${SHA}"/>`));
          case "/other":
            return html(page(`<meta name="build-commit" content="deadbeef"/>`));
          case "/none":
            return html(page(""));
          case "/late":
            lateHits += 1;
            return html(
              page(`<meta name="build-commit" content="${lateHits > 2 ? SHA : "deadbeef"}"/>`),
            );
          case "/moved":
            return new Response(null, {
              status: 301,
              headers: { location: "https://example.com/" },
            });
          default:
            return new Response("no", { status: 404 });
        }
      },
    });
  });
  afterAll(() => server.stop(true));

  test("passes when the page names the sha", async () => {
    expect(await checkCommit(`${base()}/match`, SHA, fast)).toEqual({ ok: true, seen: SHA });
  });

  test("fails on another sha, and says which it saw", async () => {
    expect(await checkCommit(`${base()}/other`, SHA, fast)).toEqual({
      ok: false,
      seen: "deadbeef",
    });
  });

  test("fails when the page has no meta", async () => {
    expect(await checkCommit(`${base()}/none`, SHA, fast)).toEqual({
      ok: false,
      seen: "no build-commit meta",
    });
  });

  test("retries until the new build answers", async () => {
    const log: string[] = [];
    const result = await checkCommit(`${base()}/late`, SHA, { ...fast, log: (l) => log.push(l) });
    expect(result).toEqual({ ok: true, seen: SHA });
    expect(log).toHaveLength(2);
  });

  test("a redirect fails at once, naming where it points", async () => {
    const started = Date.now();
    const result = await checkCommit(`${base()}/moved`, SHA, {
      timeoutMs: 5_000,
      intervalMs: 1_000,
    });
    expect(result).toEqual({ ok: false, seen: "a 301 redirect to https://example.com/" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("every request carries a fresh cache-busting query", () => {
    const busts = queries.filter(Boolean);
    expect(busts.length).toBe(queries.length);
    expect(new Set(busts).size).toBe(busts.length);
  });
});

describe("buildCommitsIn", () => {
  test("reads the meta whatever the attribute order", () => {
    expect(buildCommitsIn(`<meta content="abc" name="build-commit">`)).toEqual(["abc"]);
    expect(buildCommitsIn(`<meta name="description" content="x"/>`)).toEqual([]);
  });
});
