import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN, fakeApi, home, login, project } from "./remote-support.ts";

afterAll(cleanup);

describe("resolution order", () => {
  test("token: --token-path, then PIXELSLASH_TOKEN, then the stored credential", async () => {
    const env = await home();
    const api = fakeApi({ tokens: [USER_TOKEN, "psu_env", "psu_file"] });
    await login(env, api);
    const tokenPath = join(await tmp(), "token");
    await Bun.write(tokenPath, "psu_file\n");
    const via = async (argv: string[], extra: Record<string, string> = {}) => {
      const cap = capture();
      await run(["whoami", "--server", SERVER, ...argv], cap.io, {
        env: { ...env, ...extra },
        fetch: api.fetch,
      });
      return { line: cap.stdout.split("\n")[1], auth: api.seen.at(-1)?.auth };
    };
    expect(await via(["--token-path", tokenPath], { PIXELSLASH_TOKEN: "psu_env" })).toEqual({
      line: "token: --token-path",
      auth: "Bearer psu_file",
    });
    expect(await via([], { PIXELSLASH_TOKEN: "psu_env" })).toEqual({
      line: "token: PIXELSLASH_TOKEN",
      auth: "Bearer psu_env",
    });
    expect(await via([])).toEqual({
      line: "token: stored credential",
      auth: `Bearer ${USER_TOKEN}`,
    });
  });

  test("server: --server, then PIXELSLASH_SERVER, then upload.server in the config", async () => {
    const cwd = await tmp();
    await Bun.write(
      join(cwd, "pixelslash.config.json"),
      JSON.stringify({
        baseUrl: "http://x",
        routes: ["/"],
        upload: { server: "https://config.example" },
      }),
    );
    const api = fakeApi();
    const host = async (argv: string[], extra: Record<string, string> = {}) => {
      await run(["whoami", ...argv], capture().io, {
        env: { PIXELSLASH_TOKEN: USER_TOKEN, ...extra },
        fetch: api.fetch,
        cwd,
      });
      return api.seen.at(-1)?.url.host;
    };
    const env = { PIXELSLASH_SERVER: "https://env.example" };
    expect(await host(["--server", "https://flag.example"], env)).toBe("flag.example");
    expect(await host([], env)).toBe("env.example");
    expect(await host([])).toBe("config.example");
  });

  test("project: --project, then upload.project, then the only one the token sees", async () => {
    const cwd = await tmp();
    const two = fakeApi({ projects: [project("p1", "web"), project("p2", "app")] });
    const deps = { env: { PIXELSLASH_TOKEN: USER_TOKEN }, fetch: two.fetch, cwd };
    const cap = capture();
    expect(await run(["builds", "--server", SERVER], cap.io, deps)).toBe(2);
    expect(cap.stderr).toContain("the token sees 2 projects");
    expect(cap.stderr).toContain("web (Acme) p1");
    expect(cap.stderr).toContain("app (Acme) p2");

    expect(await run(["builds", "--server", SERVER, "--project", "web"], capture().io, deps)).toBe(
      0,
    );
    expect(two.seen.at(-1)?.url.pathname).toBe("/api/v1/projects/p1/builds");

    await Bun.write(
      join(cwd, "pixelslash.config.json"),
      JSON.stringify({ baseUrl: "http://x", routes: ["/"], upload: { project: "p1" } }),
    );
    expect(await run(["builds", "--server", SERVER], capture().io, deps)).toBe(0);
    expect(two.seen.at(-1)?.url.pathname).toBe("/api/v1/projects/p1/builds");

    const one = fakeApi();
    expect(
      await run(["builds", "--server", SERVER], capture().io, {
        ...deps,
        cwd: await tmp(),
        fetch: one.fetch,
      }),
    ).toBe(0);
    expect(one.seen.at(-1)?.url.pathname).toBe("/api/v1/projects/p1/builds");
  });

  test("an unknown --project is a usage error listing what the token sees", async () => {
    const cap = capture();
    const code = await run(["builds", "--server", SERVER, "--project", "nope"], cap.io, {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: fakeApi().fetch,
      cwd: await tmp(),
    });
    expect(code).toBe(2);
    expect(cap.stderr).toContain(`"nope" is not a project this token sees`);
  });
});
