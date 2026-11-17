import { afterAll, describe, expect, test } from "vitest";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN, build, fakeApi } from "./remote-support.ts";

afterAll(cleanup);

const status = (...more: string[]) => ["status", "--server", SERVER, ...more];

const buildAt = (id: string, state: string) => ({
  api_version: 1,
  build: { ...build(id), status: state, snapshots: [] },
});

/** `deps` over a `fakeApi` whose project builds list is answered by `page(cursor)`. */
async function paged(
  page: (cursor: string | null) => { builds: unknown[]; next_cursor: string | null },
  replies: Record<string, unknown> = {},
) {
  const api = fakeApi();
  Object.assign(api.replies, replies);
  const lists: string[] = [];
  const fetch = (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (url.pathname === "/api/v1/projects/p1/builds") {
      lists.push(url.search);
      api.replies[url.pathname] = { api_version: 1, ...page(url.searchParams.get("cursor")) };
    }
    return api.fetch(raw, init);
  };
  const deps = { env: { PIXELSLASH_TOKEN: USER_TOKEN }, fetch, cwd: await tmp() };
  return { api, lists, deps };
}

describe("pixelslash status paging the project's builds", () => {
  test("--commit follows next_cursor to an older page", async () => {
    const p = await paged(
      (cursor) =>
        cursor === null
          ? { builds: [build("b2")], next_cursor: "c1" }
          : { builds: [{ ...build("b1"), commit_sha: "abc1234ffff" }], next_cursor: null },
      { "/api/v1/builds/b1": buildAt("b1", "passed") },
    );
    const cap = capture();
    expect(await run(status("--commit", "abc1234"), cap.io, p.deps)).toBe(0);
    expect(cap.stdout).toContain("build b1");
    expect(p.lists).toEqual(["?limit=100", "?limit=100&cursor=c1"]);
  });

  test("a commit on no page exits 3 with the plain message once the last page is read", async () => {
    const p = await paged((cursor) =>
      cursor === null
        ? { builds: [build("b2")], next_cursor: "c1" }
        : { builds: [build("b1")], next_cursor: null },
    );
    const cap = capture();
    expect(await run(status("--commit", "deadbee"), cap.io, p.deps)).toBe(3);
    expect(p.lists).toHaveLength(2);
    expect(cap.stderr).toContain("no build in web at commit deadbee");
    expect(cap.stderr).not.toContain("newest 1000");
  });

  test("stops at 10 pages and says the commit may be older", async () => {
    const p = await paged(() => ({ builds: [build("b2")], next_cursor: "more" }));
    const cap = capture();
    expect(await run(status("--commit", "deadbee"), cap.io, p.deps)).toBe(3);
    expect(p.lists).toHaveLength(10);
    expect(cap.stderr).toContain(
      "no build in web at commit deadbee among its newest 1000 builds; name an older one with --build",
    );
  });
});

describe("pixelslash status with a build status it does not know", () => {
  test("--wait exits 3 at once, naming the status", async () => {
    const api = fakeApi();
    api.replies["/api/v1/builds/b2"] = {
      api_version: 1,
      build: { ...build("b2"), status: "archived", snapshots: [] },
    };
    const sleeps: number[] = [];
    const deps = {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: api.fetch,
      cwd: await tmp(),
      now: () => 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    };
    const cap = capture();
    expect(await run(status("--build", "b2", "--wait"), cap.io, deps)).toBe(3);
    expect(sleeps).toEqual([]);
    expect(api.seen.filter((s) => s.url.pathname === "/api/v1/builds/b2")).toHaveLength(1);
    expect(cap.stderr).toContain(
      'build b2 has status "archived", which this pixelslash does not know; update pixelslash',
    );
  });
});
