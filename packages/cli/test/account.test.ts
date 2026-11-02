import { afterAll, describe, expect, test } from "vitest";
import { existsSync, statSync } from "node:fs";
import { CLIENT_VERSION } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import {
  SERVER,
  USER_TOKEN,
  credentials,
  fakeApi,
  home,
  login,
  project,
} from "./remote-support.ts";

afterAll(cleanup);

describe("pixelslash login / logout", () => {
  test("checks the token, stores it for the server at 0600, and never prints it", async () => {
    const env = await home();
    const api = fakeApi();
    const { code, cap } = await login(env, api);
    expect(code).toBe(0);
    expect(cap.stdout).toBe(`logged in to ${SERVER} as ada\n`);
    expect(cap.stderr).toContain(`${SERVER}/settings`);
    expect(cap.stdout + cap.stderr).not.toContain(USER_TOKEN);
    expect(api.seen.map((s) => s.url.pathname)).toEqual(["/api/v1/me"]);
    const path = credentials(env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await Bun.file(path).json()).toEqual({ servers: { [SERVER]: { token: USER_TOKEN } } });
  });

  test("a token the server refuses is not stored and exits 3", async () => {
    const env = await home();
    const { code, cap } = await login(env, fakeApi({ tokens: [] }));
    expect(code).toBe(3);
    expect(cap.stderr).toContain("401 unauthorized: invalid token");
    expect(existsSync(credentials(env))).toBe(false);
  });

  test("a CI token is refused as a login, exit 2", async () => {
    const env = await home();
    const { code, cap } = await login(env, fakeApi({ tokens: ["psci_x"] }), "psci_x");
    expect(code).toBe(2);
    expect(cap.stderr).toContain("personal token");
    expect(existsSync(credentials(env))).toBe(false);
  });

  test("logout forgets the server's token", async () => {
    const env = await home();
    await login(env);
    const cap = capture();
    expect(await run(["logout", "--server", `${SERVER}/`], cap.io, { env })).toBe(0);
    expect(cap.stdout).toBe(`logged out of ${SERVER}\n`);
    expect(await Bun.file(credentials(env)).json()).toEqual({ servers: {} });
    const again = capture();
    expect(await run(["logout", "--server", SERVER], again.io, { env })).toBe(0);
    expect(again.stdout).toBe(`not logged in to ${SERVER}\n`);
  });
});

describe("pixelslash whoami", () => {
  test("prints the server, where the token came from, the user and their orgs", async () => {
    const env = await home();
    const api = fakeApi({ projects: [project("p1", "web"), project("p2", "app", "Other")] });
    await login(env, api);
    const cap = capture();
    expect(await run(["whoami", "--server", SERVER], cap.io, { env, fetch: api.fetch })).toBe(0);
    expect(cap.stdout).toBe(
      `server: ${SERVER}\ntoken: stored credential\nuser: ada (Ada Lovelace)\norgs: Acme, Other\n`,
    );
  });

  test("sends User-Agent pixelslash/<version> and the bearer token", async () => {
    const api = fakeApi();
    await run(["whoami", "--server", SERVER], capture().io, {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: api.fetch,
    });
    expect(api.seen.length).toBeGreaterThan(0);
    for (const s of api.seen) {
      expect(s.agent).toBe(`pixelslash/${CLIENT_VERSION}`);
      expect(s.auth).toBe(`Bearer ${USER_TOKEN}`);
    }
  });

  test("not logged in is a usage error that says how to log in", async () => {
    const cap = capture();
    const code = await run(["whoami", "--server", SERVER], cap.io, { env: await home() });
    expect(code).toBe(2);
    expect(cap.stderr).toContain(`pixelslash login --server ${SERVER}`);
  });

  test("a server that cannot be reached exits 3", async () => {
    const cap = capture();
    const code = await run(["whoami", "--server", SERVER], cap.io, {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    expect(code).toBe(3);
    expect(cap.stderr).toBe(`cannot reach ${SERVER}: connection refused\n`);
  });
});
