import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isObj } from "../src/api.ts";
import { mcpServer } from "../src/mcp.ts";
import { run } from "../src/run.ts";
import { capture, cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN } from "./remote-support.ts";
import { PNG_BYTES, api } from "./mcp-support.ts";
import { button, manifestDir, metricsFile, parityApi } from "./parity-support.ts";

afterAll(cleanup);

async function connected(
  fake = api(),
  env: Record<string, string> = { PIXELSLASH_TOKEN: USER_TOKEN },
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const { server } = mcpServer(
    { server: SERVER },
    { env, fetch: fake.fetch, cwd: await tmp() },
    { write: () => {} },
  );
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = (name: string, args: Record<string, unknown> = {}) => tool(client, name, args);
  return { client, call, fake };
}

/** A tool's result, narrowed to the content form every tool here answers with. */
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

type Result = Awaited<ReturnType<typeof tool>>;

const json = (r: Result): Record<string, unknown> => {
  const [first] = r.content;
  if (first?.type !== "text") throw new Error("no text");
  const parsed: unknown = JSON.parse(first.text);
  if (!isObj(parsed)) throw new Error("not an object");
  return parsed;
};

describe("pixelslash mcp", () => {
  test("lists the server's read tools, each read-only, and the local dev and fix-loop tools", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const dev = tools.filter((t) => t.name.startsWith("dev_"));
    expect(dev.map((t) => t.name).toSorted()).toEqual([
      "dev_latest",
      "dev_pin",
      "dev_run",
      "dev_spec",
      "dev_start",
      "dev_stop",
      "dev_unpin",
    ]);
    // Nothing that writes to the server: the dev tools touch the worktree's store only.
    expect(tools.some((t) => /accept|reject|upload/.test(t.name))).toBe(false);
    const LOCAL = [
      "capture_local",
      "check_flake",
      "check_local",
      "resolve_flake",
      "suggest_ignore",
    ];
    const local = tools.filter((t) => LOCAL.includes(t.name));
    expect(local.map((t) => t.name).toSorted()).toEqual(LOCAL);
    const read = tools.filter((t) => !t.name.startsWith("dev_") && !LOCAL.includes(t.name));
    expect(read.map((t) => t.name).toSorted()).toEqual([
      "get_build",
      "get_parity",
      "get_parity_view",
      "get_snapshot",
      "get_snapshot_images",
      "list_builds",
      "list_detection_flags",
      "list_flakes",
      "list_projects",
      "list_stale",
      "whoami",
    ]);
    expect(read.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();
  });

  test("each read tool returns the API's reply", async () => {
    const { call, fake } = await connected();
    expect(json(await call("whoami"))).toMatchObject({
      server: SERVER,
      via: "PIXELSLASH_TOKEN",
      me: { kind: "user", user: { login: "ada" } },
    });
    expect(json(await call("list_projects")).projects).toHaveLength(1);
    const builds = await call("list_builds", { branch: "feature", status: "changes" });
    expect(json(builds).builds).toHaveLength(2);
    const query = fake.seen.at(-1)?.url.searchParams;
    expect([query?.get("branch"), query?.get("status")]).toEqual(["feature", "changes"]);
    expect(json(await call("get_build", { build_id: "b2" })).build).toMatchObject({ id: "b2" });
    expect(json(await call("get_snapshot", { snapshot_id: "s1" })).snapshot).toMatchObject({
      id: "s1",
    });
    expect(json(await call("list_flakes", { project: "web" })).flakes).toEqual([{ id: "f1" }]);
    expect(json(await call("list_detection_flags")).detection_flags).toHaveLength(1);
    fake.replies["/api/v1/projects/p1/stale"] = { api_version: 1, stale: [{ name: "Button" }] };
    expect(json(await call("list_stale", { project: "web", platform: "ios" })).stale).toEqual([
      { name: "Button" },
    ]);
    expect(fake.seen.at(-1)?.url.searchParams.get("platform")).toBe("ios");
    expect(fake.images).toEqual([]);
  });

  test("get_snapshot_images returns the PNGs that exist, and fetches only on that call", async () => {
    const { call, fake } = await connected();
    const r = await call("get_snapshot_images", { snapshot_id: "s1" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([
      { type: "text", text: "head:" },
      { type: "image", mimeType: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") },
      { type: "text", text: "baseline:" },
      { type: "image", mimeType: "image/png", data: Buffer.from(PNG_BYTES).toString("base64") },
      { type: "text", text: "diff: none" },
    ]);
    expect(fake.images).toEqual(["/images/head", "/images/base"]);
    const one = await call("get_snapshot_images", { snapshot_id: "s1", which: "baseline" });
    expect(one.content.map((c) => c.type)).toEqual(["text", "image"]);
  });

  test("get_snapshot inlines the layout metrics file when the snapshot has one, and only then", async () => {
    const { call, fake } = await connected();
    const shot = json(await call("get_snapshot", { snapshot_id: "s3" })).snapshot;
    expect(shot).toMatchObject({
      id: "s3",
      metrics: { version: "1.0", root: "a", parts: { a: { box: { w: 1, h: 2 } } } },
    });
    expect(fake.images).toEqual(["/images/orgs/o/m.metrics.json"]);
    // No metrics_url: the reply is the API's own, with no `metrics` field and no extra fetch.
    const plain = json(await call("get_snapshot", { snapshot_id: "s1" })).snapshot;
    expect(plain).not.toHaveProperty("metrics");
    expect(fake.images).toEqual(["/images/orgs/o/m.metrics.json"]);
  });

  test("get_parity_view returns the parity view read for one key and sends the key", async () => {
    const { call, fake } = await connected();
    fake.replies["/api/v1/builds/b2/parity"] = {
      api_version: 1,
      name: "Button/primary",
      theme: "dark",
      columns: [{ kind: "shot", platform: "web" }],
    };
    const view = json(
      await call("get_parity_view", { build_id: "b2", name: "Button/primary", theme: "dark" }),
    );
    expect(view).toMatchObject({ name: "Button/primary", theme: "dark" });
    const query = fake.seen.at(-1)?.url.searchParams;
    expect([query?.get("name"), query?.get("theme")]).toEqual(["Button/primary", "dark"]);
    const missing = await call("get_parity_view", { build_id: "b2", name: "Button/primary" });
    expect(missing.isError).toBe(true);
  });

  test("get_parity returns what `pixelslash parity --json` prints, reading the manifest from the cwd", async () => {
    const shots = [
      { id: "w1", platform: "web" as const, metrics: metricsFile({ button: button({ gap: 8 }) }) },
      {
        id: "a1",
        platform: "android" as const,
        metrics: metricsFile({ button: button({ gap: 6 }) }),
      },
    ];
    const fake = parityApi(shots);
    // The cwd's manifest declares the gap difference, so a tool that read another directory would see drift.
    const cwd = await manifestDir({
      version: 1,
      differences: {
        "Button/md-primary": { button: { web: { gap: 8 }, android: { gap: 6 } } },
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const { server } = mcpServer(
      { server: SERVER },
      { env: { PIXELSLASH_TOKEN: USER_TOKEN }, fetch: fake.fetch, cwd },
      { write: () => {} },
    );
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const viaMcp = json(await tool(client, "get_parity", { build_id: "b2" }));
    expect(viaMcp).toMatchObject({ build: "b2", pairs: 1, drift: 0, not_measured: 0 });
    const cap = capture();
    await run(["parity", "--build", "b2", "--server", SERVER, "--json"], cap.io, {
      env: { PIXELSLASH_TOKEN: USER_TOKEN },
      fetch: fake.fetch,
      cwd,
    });
    expect(viaMcp).toEqual(JSON.parse(cap.stdout));
    await client.close();
  });

  test("an image URL off the configured server is not fetched", async () => {
    const { call, fake } = await connected();
    const r = await call("get_snapshot_images", { snapshot_id: "s2" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("not on https://ps.example");
    expect(fake.images).toEqual([]);
  });

  test("an API error, a bad token or no token is a tool error, and the server keeps serving", async () => {
    const { call } = await connected();
    const missing = await call("get_build", { build_id: "nope" });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("404 not_found");
    expect((await call("get_build")).isError).toBe(true);
    expect((await call("list_projects")).isError).toBeFalsy();

    const bad = await connected(api(), { PIXELSLASH_TOKEN: "psu_wrong" });
    const refused = await bad.call("list_projects");
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("401 unauthorized");
    expect(JSON.stringify(refused.content)).not.toContain("psu_wrong");

    const none = await connected(api(), { HOME: await tmp() });
    const out = await none.call("whoami");
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out.content)).toContain("not logged in");
  });
});

describe("pixelslash mcp over stdio", () => {
  let client: Client;
  let http: ReturnType<typeof Bun.serve>;

  // The spawn and the handshake are the fixture, and the whole cost of this file's one slow
  // test: a process starting from cold, which a busy host stretches by many times. The test
  // times only what the server does once it is up. The hook keeps the 5 s the test had: the
  // gain is the shared cache above, not a bigger budget.
  beforeAll(async () => {
    let origin = "";
    const fake = api("http://placeholder");
    http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/api/v1/snapshots/s1")
          return Response.json({
            api_version: 1,
            snapshot: { id: "s1", images: { head: `${origin}/images/head` } },
          });
        return fake.fetch(`${SERVER}${url.pathname}${url.search}`, { headers: req.headers });
      },
    });
    origin = `http://127.0.0.1:${http.port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/index.ts", import.meta.url)), "mcp", "--server", origin],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: await tmp(),
        // A fresh HOME has no Bun cache, so the bin transpiled the whole CLI and the MCP SDK from
        // nothing on every spawn (0.44 s against 0.27 s idle). The cache is the machine's, not the
        // user's login, so the child shares the parent's.
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
        PIXELSLASH_TOKEN: USER_TOKEN,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
  }, 5_000);

  afterAll(async () => {
    await client?.close();
    await http?.stop(true);
  });

  test("a client spawning the bin lists projects and reads a snapshot's images", async () => {
    const projects = await tool(client, "list_projects");
    expect(json(projects).projects).toHaveLength(1);
    const shots = await tool(client, "get_snapshot_images", {
      snapshot_id: "s1",
      which: "head",
    });
    expect(shots.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});
