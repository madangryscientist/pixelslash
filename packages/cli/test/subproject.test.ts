import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import { fakeUploadApi, gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

/** `--subproject`, `upload.subproject`, `upload --skipped` and `project create --parent`. */

const SERVER = "https://ps.example";
const CI = { PIXELSLASH_TOKEN: "psci_env" };

const sent = (api: ReturnType<typeof fakeUploadApi>) => {
  const open = api.calls.find((c) => c.method === "POST" && c.path === "/api/v1/builds");
  const body: Record<string, unknown> = JSON.parse(open?.body ?? "{}");
  return body;
};

/** The upload stand-in, with `GET /api/v1/projects` answering a project and its subproject. */
function withProjects() {
  const api = fakeUploadApi();
  const projects = [
    { id: "p1", name: "web", org: { id: "o", name: "Acme" }, parent_project_id: null },
    { id: "p2", name: "e2e", org: { id: "o", name: "Acme" }, parent_project_id: "p1" },
  ];
  const fetch = async (url: string, init?: RequestInit) =>
    new URL(url).pathname === "/api/v1/projects" && (init?.method ?? "GET") === "GET"
      ? Response.json({ api_version: 1, projects, next_cursor: null })
      : api.fetch(url, init);
  return { ...api, fetch };
}

describe("pixelslash upload --subproject", () => {
  test("sends the subproject from the flag, else from upload.subproject; the flag wins", async () => {
    const [cwd, dir] = [await gitRepo(), await snapshotDir()];
    const byFlag = fakeUploadApi();
    const flag = ["upload", dir, "--server", SERVER, "--subproject", "e2e"];
    expect(await run(flag, capture().io, { fetch: byFlag.fetch, cwd, env: CI })).toBe(0);
    expect(sent(byFlag).subproject).toBe("e2e");

    await Bun.write(
      join(cwd, "pixelslash.config.json"),
      JSON.stringify({ baseUrl: "http://x", routes: ["/"], upload: { subproject: "storybook" } }),
    );
    const byConfig = fakeUploadApi();
    const plain = ["upload", dir, "--server", SERVER, "--flake-retries", "0"];
    expect(await run(plain, capture().io, { fetch: byConfig.fetch, cwd, env: CI })).toBe(0);
    expect(sent(byConfig).subproject).toBe("storybook");

    const both = fakeUploadApi();
    const over = [...plain, "--subproject", "e2e"];
    expect(await run(over, capture().io, { fetch: both.fetch, cwd, env: CI })).toBe(0);
    expect(sent(both).subproject).toBe("e2e");
  });

  test("no subproject sends none, so the build lands on the project itself", async () => {
    const [cwd, dir, api] = [await gitRepo(), await snapshotDir(), fakeUploadApi()];
    expect(
      await run(["upload", dir, "--server", SERVER], capture().io, {
        fetch: api.fetch,
        cwd,
        env: CI,
      }),
    ).toBe(0);
    expect(sent(api)).not.toHaveProperty("subproject");
  });

  test("--project naming a subproject is refused with the flags that name it", async () => {
    const [cwd, dir, api, cap] = [await gitRepo(), await snapshotDir(), withProjects(), capture()];
    const env = { PIXELSLASH_TOKEN: "psu_user" };
    const code = await run(["upload", dir, "--server", SERVER, "--project", "e2e"], cap.io, {
      fetch: api.fetch,
      cwd,
      env,
    });
    expect(code).toBe(2);
    expect(cap.stderr).toContain("upload names this one with --project web --subproject e2e");
    expect(api.calls.some((c) => c.path === "/api/v1/builds")).toBe(false);

    // With one top-level project, a personal token needs no --project: the subproject does not count.
    const ok = withProjects();
    const sub = ["upload", dir, "--server", SERVER, "--subproject", "e2e"];
    expect(await run(sub, capture().io, { fetch: ok.fetch, cwd, env })).toBe(0);
    expect(sent(ok)).toMatchObject({ projectId: "p1", subproject: "e2e" });
  });
});

describe("pixelslash upload --skipped", () => {
  test("takes no DIR and opens one build marked skipped, with nothing else sent", async () => {
    const [cwd, api, cap] = [await gitRepo(), fakeUploadApi(), capture()];
    const argv = ["upload", "--skipped", "--server", SERVER, "--subproject", "e2e"];
    expect(await run(argv, cap.io, { fetch: api.fetch, cwd, env: CI })).toBe(0);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/v1/builds"]);
    expect(sent(api)).toMatchObject({ skipped: true, subproject: "e2e", branch: "feat" });
    expect(cap.stdout).toMatch(/recorded a skipped run \(no shots\)\nbuild: build-1/);
  });
});

describe("pixelslash project create --parent", () => {
  test("sends the parent", async () => {
    const api = fakeUploadApi();
    const code = await run(
      ["project", "create", "e2e", "--parent", "web", "--server", SERVER, "--json"],
      capture().io,
      { fetch: api.fetch, env: { PIXELSLASH_TOKEN: "psorg_x" } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(api.calls[0]?.body ?? "{}")).toEqual({ name: "e2e", parent: "web" });
  });
});
