import { afterAll, describe, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { SERVER, USER_TOKEN, fakeApi, home, login, project } from "./remote-support.ts";
import { capture, cleanup, tmp } from "./support.ts";

afterAll(cleanup);

const CLI = join(import.meta.dirname, "..", "src", "index.ts");

/** An app (404 on `/index.json`) or a Storybook (an index with `entries`). */
function serve(storybook: boolean) {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      storybook && new URL(req.url).pathname === "/index.json"
        ? Response.json({ v: 5, entries: { "button--primary": { id: "button--primary" } } })
        : new Response("not found", { status: 404 }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** No network: every probe is a 404, so nothing is taken for a Storybook. */
const offline = async () => new Response("", { status: 404 });

async function init(argv: string[], deps: Parameters<typeof run>[2] = {}) {
  const cap = capture();
  const code = await run(["init", ...argv], cap.io, { env: {}, fetch: offline, ...deps });
  return { code, cap };
}

const config = (cwd: string) => readFile(join(cwd, "pixelslash.config.ts"), "utf8");

describe("pixelslash init", () => {
  test("answers on stdin write a config the loader takes, and the snapshot dirs are ignored", async () => {
    const app = serve(false);
    const cwd = await tmp();
    try {
      const env = { ...process.env, HOME: cwd, PIXELSLASH_SERVER: "", PIXELSLASH_TOKEN: "" };
      const proc = Bun.spawn([process.execPath, CLI, "init"], {
        cwd,
        env,
        stdin: new TextEncoder().encode(`${app.url}\n/, /about\n1280x720,375x812\nlight,dark\n\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(stderr).toContain("App URL (or a running Storybook) [http://localhost:3000]: ");
      expect(stdout).toContain("wrote pixelslash.config.ts");
      expect(stdout).toContain("pixelslash check");
      expect(stdout).toContain("pixelslash capture --upload");
      expect(stdout).toContain("pixelslash upload pixelslash-snapshots --wait");
      const c = await loadConfig(join(cwd, "pixelslash.config.ts"));
      expect(c.baseUrl).toBe(app.url);
      expect(c.routes.map((r) => r.path)).toEqual(["/", "/about"]);
      expect(c.variants.map((v) => v.name)).toEqual([
        "chromium-1280x720-light",
        "chromium-1280x720-dark",
        "chromium-375x812-light",
        "chromium-375x812-dark",
      ]);
      expect(c.flaky).toBeUndefined();
      expect(c.upload.server).toBeUndefined();
      expect(await config(cwd)).toContain('// flaky: "review",');
      expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(
        "pixelslash-snapshots/\n.pixelslash/\n",
      );
    } finally {
      await app.stop();
    }
  });

  test("flags only, --yes: defaults fill the rest and nothing is asked", async () => {
    const cwd = await tmp();
    const asked: string[] = [];
    const { code } = await init(["--url", "http://localhost:5173/", "--yes"], {
      cwd,
      ask: async (q) => {
        asked.push(q);
        return "";
      },
    });
    expect(code).toBe(0);
    expect(asked).toEqual([]);
    const c = await loadConfig(join(cwd, "pixelslash.config.ts"));
    expect(c.baseUrl).toBe("http://localhost:5173");
    expect(c.routes.map((r) => r.path)).toEqual(["/"]);
    expect(c.variants.map((v) => v.name)).toEqual(["chromium-1280x720-light"]);
  });

  test("a URL whose index.json answers is a Storybook: every story, no routes asked", async () => {
    const sb = serve(true);
    const cwd = await tmp();
    try {
      const asked: string[] = [];
      const { code, cap } = await init([], {
        cwd,
        fetch: globalThis.fetch.bind(globalThis),
        ask: async (q) => {
          asked.push(q);
          return q.startsWith("App URL") ? sb.url : "";
        },
      });
      expect(code).toBe(0);
      expect(cap.stderr).toContain(`Storybook found at ${sb.url}`);
      expect(asked.some((q) => q.startsWith("Routes"))).toBe(false);
      const c = await loadConfig(join(cwd, "pixelslash.config.ts"));
      expect(c.storybook?.url).toBe(sb.url);
      expect(c.routes).toEqual([]);
    } finally {
      await sb.stop();
    }
  });

  test("an app URL that is not a Storybook asks for routes", async () => {
    const app = serve(false);
    const cwd = await tmp();
    try {
      const { code } = await init(["--url", app.url, "--yes"], {
        cwd,
        fetch: globalThis.fetch.bind(globalThis),
      });
      expect(code).toBe(0);
      expect((await loadConfig(join(cwd, "pixelslash.config.ts"))).storybook).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

  test("logged in: the server and its one project come from whoami, and no token is written", async () => {
    const cwd = await tmp();
    const env = await home();
    const api = fakeApi();
    await login(env, api);
    const { code } = await init(["--url", "http://localhost:3000", "--server", SERVER, "--yes"], {
      cwd,
      env,
      fetch: api.fetch,
    });
    expect(code).toBe(0);
    const c = await loadConfig(join(cwd, "pixelslash.config.ts"));
    expect(c.upload).toEqual({ server: SERVER, project: "web", baseBranch: undefined });
    expect(await config(cwd)).not.toContain(USER_TOKEN);
  });

  test("more than one project is asked for by name", async () => {
    const cwd = await tmp();
    const env = await home();
    const api = fakeApi({ projects: [project("p1", "web"), project("p2", "app")] });
    await login(env, api);
    const { code } = await init(["--url", "http://localhost:3000", "--server", SERVER], {
      cwd,
      env,
      fetch: api.fetch,
      ask: async (q) => (q.startsWith("Project (web, app)") ? "app" : ""),
    });
    expect(code).toBe(0);
    expect((await loadConfig(join(cwd, "pixelslash.config.ts"))).upload.project).toBe("app");
  });

  test("not logged in: the server is written, the project left commented", async () => {
    const cwd = await tmp();
    const { code, cap } = await init(["--server", SERVER, "--yes"], { cwd, env: await home() });
    expect(code).toBe(0);
    expect(cap.stderr).toContain(`not logged in to ${SERVER}`);
    expect(await config(cwd)).toContain('// project: "<project name>"');
    expect((await loadConfig(join(cwd, "pixelslash.config.ts"))).upload.server).toBe(SERVER);
  });

  test("an existing config is kept without --force, replaced with it", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "pixelslash.config.ts"), "export default {};\n");
    const refused = await init(["--yes"], { cwd });
    expect(refused.code).toBe(2);
    expect(refused.cap.stderr).toContain("pixelslash.config.ts already exists: --force");
    expect(await config(cwd)).toBe("export default {};\n");
    const forced = await init(["--yes", "--force"], { cwd });
    expect(forced.code).toBe(0);
    expect(await config(cwd)).toContain('baseUrl: "http://localhost:3000"');
  });

  test("a JSON config counts as existing too", async () => {
    const cwd = await tmp();
    await writeFile(join(cwd, "pixelslash.config.json"), "{}\n");
    expect((await init(["--yes"], { cwd })).code).toBe(2);
  });

  test(".gitignore: missing entries appended once, present ones (any slashes) left alone", async () => {
    const cwd = await tmp();
    const path = join(cwd, ".gitignore");
    await writeFile(path, "node_modules\n/pixelslash-snapshots");
    const first = await init(["--yes"], { cwd });
    expect(first.cap.stdout).toContain(".gitignore: added .pixelslash/\n");
    expect(await readFile(path, "utf8")).toBe(
      "node_modules\n/pixelslash-snapshots\n.pixelslash/\n",
    );
    const again = await init(["--yes", "--force"], { cwd });
    expect(again.cap.stdout).toContain(".gitignore: already ignores the snapshot dirs");
    expect(await readFile(path, "utf8")).toBe(
      "node_modules\n/pixelslash-snapshots\n.pixelslash/\n",
    );
  });

  test("bad answers are usage errors and write nothing", async () => {
    const cwd = await tmp();
    for (const argv of [
      ["--url", "localhost:3000"],
      ["--routes", "about"],
      ["--viewports", "big"],
      ["--themes", "sepia"],
      ["--url", "http://a", "--storybook", "http://b"],
      ["--viewports", "1280x720,1280x720"],
      ["--routes", "/a,/a/"],
    ]) {
      const { code } = await init([...argv, "--yes"], { cwd });
      expect({ argv, code }).toEqual({ argv, code: 2 });
    }
    expect(await Bun.file(join(cwd, "pixelslash.config.ts")).exists()).toBe(false);
  });

  test("an answer cannot break out of its string", async () => {
    const cwd = await tmp();
    await init(["--routes", '/a"+process.exit(9)+"', "--yes"], { cwd });
    const c = await loadConfig(join(cwd, "pixelslash.config.ts"));
    expect(c.routes.map((r) => r.path)).toEqual(['/a"+process.exit(9)+"']);
  });
});
