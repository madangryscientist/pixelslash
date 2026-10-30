import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isObj } from "../src/api.ts";
import { mcpServer } from "../src/mcp.ts";
import { cleanup, tmp } from "./support.ts";
import { SERVER, USER_TOKEN, fakeApi } from "./remote-support.ts";

afterAll(cleanup);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/** The fake API, plus the read endpoints the MCP tools add and a signed image route. */
function api(server = SERVER) {
  const base = fakeApi();
  Object.assign(base.replies, {
    "/api/v1/snapshots/s1": {
      api_version: 1,
      snapshot: {
        id: "s1",
        name: "home",
        group: "changed",
        images: {
          head: `${server}/images/head`,
          baseline: `${server}/images/base`,
          diff: null,
        },
      },
    },
    "/api/v1/snapshots/s2": {
      api_version: 1,
      snapshot: { id: "s2", images: { head: "https://elsewhere.example/x.png" } },
    },
    "/api/v1/projects/p1/flakes": { api_version: 1, flakes: [{ id: "f1" }], next_cursor: null },
    "/api/v1/projects/p1/detection-flags": {
      api_version: 1,
      detection_flags: [{ id: "d1", kind: "missed" }],
      next_cursor: null,
    },
  });
  const images: string[] = [];
  const fetch = async (raw: string, init?: RequestInit) => {
    const url = new URL(raw);
    if (!url.pathname.startsWith("/images/")) return base.fetch(raw, init);
    images.push(url.pathname);
    return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
  };
  return { ...base, fetch, images };
}

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
      "get_snapshot",
      "get_snapshot_images",
      "list_builds",
      "list_detection_flags",
      "list_flakes",
      "list_projects",
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
  test("a client spawning the bin lists projects and reads a snapshot's images", async () => {
    let origin = "";
    const fake = api("http://placeholder");
    const http = Bun.serve({
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
      env: { PATH: process.env.PATH ?? "", HOME: await tmp(), PIXELSLASH_TOKEN: USER_TOKEN },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(transport);
      const projects = await tool(client, "list_projects");
      expect(json(projects).projects).toHaveLength(1);
      const shots = await tool(client, "get_snapshot_images", {
        snapshot_id: "s1",
        which: "head",
      });
      expect(shots.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    } finally {
      await client.close();
      await http.stop(true);
    }
  });
});
