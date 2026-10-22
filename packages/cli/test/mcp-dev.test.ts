import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { devStore, liveSession } from "@pixelslash/engine";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isObj } from "../src/api.ts";
import { mcpServer } from "../src/mcp.ts";
import { run } from "../src/run.ts";
import { featureProject, project, until } from "./dev-support.ts";
import { capture, cleanup, pngWidth } from "./support.ts";

afterAll(cleanup);

/** Feature mode over MCP (ob 1742): the dev tools, each against its `pixelslash dev … --json` twin. */

const pinned = { PIXELSLASH_IMAGE_VERSION: "test" };
const base = { listFonts: async () => [], which: () => null };

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}
type Result = Awaited<ReturnType<typeof tool>>;

const json = (r: Result): Record<string, unknown> => {
  const [first] = r.content;
  if (first?.type !== "text") throw new Error(`no text: ${JSON.stringify(r.content)}`);
  return JSON.parse(first.text);
};
const images = (r: Result) => r.content.flatMap((c) => (c.type === "image" ? [c.data] : []));
const widthOf = (data: string) => pngWidth(Buffer.from(data, "base64"));

/** The CLI twin's stdout, parsed. */
async function cli(cwd: string, argv: string[]): Promise<Record<string, unknown>> {
  const cap = capture();
  const code = await run(["dev", ...argv, "--json"], cap.io, { ...base, cwd, env: pinned });
  if (code !== 0) throw new Error(`dev ${argv.join(" ")} exited ${code}: ${cap.stderr}`);
  return JSON.parse(cap.stdout);
}

/** The test's own env, minus what is unset. */
const env = () =>
  Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );

/** A client on the bin's stdio, started in `cwd` as an agent's MCP config would start it. */
async function stdio(cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/index.ts", import.meta.url)), "mcp"],
    cwd,
    env: { ...env(), ...pinned },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

async function inMemory(cwd: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = mcpServer({}, { ...base, cwd, env: pinned }, { write: () => true });
  await mcp.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, close: mcp.close };
}

describe("pixelslash mcp, feature mode over stdio", () => {
  test("start, run, latest, pin, unpin, spec and stop, each equal to its CLI twin", async () => {
    // 1200 px wide: every shot and the 2048 px ref must come back at 1024.
    const { cwd, file } = await featureProject(1200);
    const store = devStore(cwd);
    const client = await stdio(cwd);
    try {
      const started = json(await tool(client, "dev_start", { target: "index" }));
      expect(started).toMatchObject({ started: true, target: "index", by: "this server" });
      const owner = await liveSession(store);
      expect(owner?.url).toBe(started.page);
      // Started again: the same session, not a second one.
      expect(json(await tool(client, "dev_start"))).toMatchObject({
        started: false,
        page: started.page,
        by: "this server",
      });

      // The first run is under way when dev_start returns; edit after it, as an agent would.
      await until(async () => ((await tool(client, "dev_latest")).isError ? undefined : true));
      // The save re-runs the session; dev_latest shows that run, its shot and diff at the cap.
      await writeFile(file, `<body style="margin:0;background:#fff"><h1>edited</h1></body>`);
      const latest = await until(async () => {
        const r = await tool(client, "dev_latest");
        return json(r).id === "000002" ? r : undefined;
      });
      expect(json(latest)).toMatchObject({ page: started.page, counts: { changed: 1 } });
      expect(latest.content.some((c) => c.type === "text" && c.text.endsWith("diff:"))).toBe(true);
      expect(images(latest)).toHaveLength(2);
      expect(images(latest).every((d) => widthOf(d) === 1024)).toBe(true);
      expect(json(latest)).toEqual(await cli(cwd, ["latest"]));

      // run: the same iteration as the twin's `latest` read straight after.
      const ran = await tool(client, "dev_run");
      expect(ran.isError).toBeFalsy();
      const it = json(ran);
      expect(it).toMatchObject({ uploaded: false, against: { iteration: "000002" } });
      expect(it).toEqual(await cli(cwd, ["latest"]));

      // The twin `dev --once`, attached to this server's session, runs through it the same way.
      const once = await cli(cwd, ["--once"]);
      expect(once).toMatchObject({ page: started.page, against: { iteration: it.id } });
      expect(json(await tool(client, "dev_latest"))).toEqual(once);

      // pin and unpin: the same state gives the same reply.
      const pin = json(await tool(client, "dev_pin"));
      expect(pin).toEqual({ pinned: once.id, pins: [once.id] });
      await cli(cwd, ["unpin"]);
      expect(await cli(cwd, ["pin"])).toEqual(pin);
      const unpin = json(await tool(client, "dev_unpin"));
      expect(unpin).toEqual({ unpinned: once.id, pins: [] });
      await cli(cwd, ["pin"]);
      expect(await cli(cwd, ["unpin"])).toEqual(unpin);

      // spec: the twin inlines each ref as a data URL; MCP sends it as the image it names.
      const spec = await tool(client, "dev_spec");
      const twin = await cli(cwd, ["spec"]);
      const refs = (Array.isArray(twin.refs) ? twin.refs : []).filter(isObj);
      expect(json(spec)).toEqual({
        ...twin,
        refs: refs.map((r, i) => ({
          ...r,
          image: typeof r.image === "string" ? `image ${i}` : null,
        })),
      });
      expect(images(spec)).toEqual([String(refs[0]?.image).replace("data:image/png;base64,", "")]);
      expect(widthOf(images(spec)[0] ?? "")).toBe(1024);

      expect(json(await tool(client, "dev_stop"))).toEqual({
        stopped: true,
        target: "index",
        page: started.page,
      });
      expect(await liveSession(store)).toBeUndefined();
      expect(json(await tool(client, "dev_stop"))).toEqual({ stopped: false });
    } finally {
      await client.close();
    }
  }, 120_000);
});

describe("pixelslash mcp, feature mode", () => {
  test("with no session, run is an error and latest says to start; the server keeps serving", async () => {
    const { cwd } = await project();
    const { client } = await inMemory(cwd);
    const ran = await tool(client, "dev_run");
    expect(ran.isError).toBe(true);
    expect(JSON.stringify(ran.content)).toContain("call dev_start");
    expect((await tool(client, "dev_latest")).isError).toBe(true);
    expect((await tool(client, "dev_pin")).isError).toBeFalsy();
    expect(json(await tool(client, "dev_stop"))).toEqual({ stopped: false });
    await client.close();
  });

  test("a session on another target is refused, and closing the server ends its session", async () => {
    const { cwd } = await project();
    const { client, close } = await inMemory(cwd);
    expect(json(await tool(client, "dev_start", { target: "index" }))).toMatchObject({
      started: true,
    });
    const other = await tool(client, "dev_start", { target: "other" });
    expect(other.isError).toBe(true);
    expect(JSON.stringify(other.content)).toContain("session is on index, not other");
    await close();
    expect(await liveSession(devStore(cwd))).toBeUndefined();
    await client.close();
  }, 60_000);

  test("build-to-spec walks the loop and names no accept or upload tool", async () => {
    const { cwd } = await project();
    const { client } = await inMemory(cwd);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("build-to-spec");
    const got = await client.getPrompt({ name: "build-to-spec", arguments: { target: "cart" } });
    const [message] = got.messages;
    const body = message?.content.type === "text" ? message.content.text : "";
    for (const name of ["dev_spec", "dev_start", "dev_run", "dev_latest", "dev_pin", "dev_stop"])
      expect(body).toContain(name);
    expect(body).toContain('target "cart"');
    const { tools } = await client.listTools();
    const dev = tools.filter((t) => t.name.startsWith("dev_"));
    expect(dev.find((t) => t.name === "dev_start")?.description).toMatch(/dev_latest/);
    await client.close();
  });
});
