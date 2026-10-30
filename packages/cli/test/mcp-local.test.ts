import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type Progress } from "@modelcontextprotocol/sdk/types.js";
import { UNSTABLE_EXIT } from "../src/flake.ts";
import { mcpServer } from "../src/mcp.ts";
import { run } from "../src/run.ts";
import { SERVER, project, server } from "./local-support.ts";
import { PAGES, capture, cleanup, pngWidth } from "./support.ts";

afterAll(cleanup);

/** The local fix loop over MCP (ob 1735): each tool against its `--json` CLI twin. */

const env = { PIXELSLASH_IMAGE_VERSION: "test", PIXELSLASH_TOKEN: "psu_t" };
const base = { env, listFonts: async () => [] };

async function connected(cwd: string, api = server()) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const { server: mcp } = mcpServer(
    { server: SERVER },
    { ...base, fetch: api.fetch, cwd },
    { write: () => {} },
  );
  await mcp.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}
type Result = Awaited<ReturnType<typeof tool>>;

/** The tool's first text: its twin's JSON. */
const text = (r: Result): string => {
  const [first] = r.content;
  if (first?.type !== "text") throw new Error(`no text: ${JSON.stringify(r.content)}`);
  return first.text;
};
const json = (r: Result): Record<string, unknown> => JSON.parse(text(r));

/** The CLI twin's exit code and stdout, parsed. */
async function cli(cwd: string, argv: string[], api = server()) {
  const cap = capture();
  const code = await run([...argv, "--json"], cap.io, { ...base, fetch: api.fetch, cwd });
  if (code === 2) throw new Error(`${argv.join(" ")} exited 2: ${cap.stderr}`);
  const out: Record<string, unknown> = JSON.parse(cap.stdout);
  return { code, out };
}

const flakeArgs = (id: string, ...more: string[]) => ["flake", id, "--server", SERVER, ...more];

describe("pixelslash mcp: the local fix loop", () => {
  test("check_local returns what `check --json` prints, and uploads nothing", async () => {
    const [cwd, api] = [await project(), server()];
    const client = await connected(cwd, api);
    const r = await tool(client, "check_local", { only: "index", flake_retries: "0" });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body).toMatchObject({
      measured: "local",
      uploaded: false,
      shots: [{ name: "index", status: "changed" }],
    });
    expect(api.seen.every((s) => s.method === "GET" || s.path === "/api/v1/baselines")).toBe(true);
    const twin = await cli(cwd, [
      "check",
      "--server",
      SERVER,
      "--only",
      "index",
      "--flake-retries",
      "0",
    ]);
    expect(twin.code).toBe(0);
    // The same run measured twice: the same report, each with its own timings.
    expect(body["timings"]).toMatchObject({ totalMs: expect.any(Number) });
    expect({ ...body, timings: null }).toEqual({ ...twin.out, timings: null });
    await client.close();
  }, 60_000);

  test("capture_local returns each PNG's path and the PNG; `capture --only --json` prints the same", async () => {
    const cwd = await project();
    const client = await connected(cwd);
    const r = await tool(client, "capture_local", { only: "index" });
    expect(r.isError).toBeFalsy();
    const body: { shots: { name: string; file: string }[]; timings: unknown } = JSON.parse(text(r));
    const { shots } = body;
    expect(shots.map((s) => s.name)).toEqual(["index"]);
    expect(await Bun.file(shots[0]?.file ?? "").exists()).toBe(true);
    const image = r.content.find((c) => c.type === "image");
    expect(image?.type === "image" && pngWidth(Buffer.from(image.data, "base64"))).toBe(400);
    expect((await tool(client, "capture_local", {})).isError).toBe(true);
    const twin = await cli(cwd, ["capture", "--only", "index"]);
    expect(twin.code).toBe(0);
    expect(body.timings).toMatchObject({
      shots: [{ name: expect.stringContaining("index"), captureMs: expect.any(Number) }],
    });
    expect({ ...body, timings: null }).toEqual({ ...twin.out, timings: null });
    await client.close();
  }, 60_000);

  test("check_flake reproduces an unstable shot with its region and fixes, and sends only reads", async () => {
    const [cwd, api] = [await project(), server()];
    const client = await connected(cwd, api);
    const body = json(await tool(client, "check_flake", { flake_id: "f1", runs: "3" }));
    expect(body).toMatchObject({ flake: { id: "f1" }, uploaded: false, stable: false });
    expect(body["area"]).toMatchObject({ x: expect.any(Number), width: expect.any(Number) });
    expect(JSON.stringify(body["suggestions"])).toContain('flaky: \\"skip\\"');
    expect(api.seen.every((s) => s.method === "GET")).toBe(true);
    const twin = await cli(cwd, flakeArgs("f1", "--runs", "3"));
    expect(twin.code).toBe(UNSTABLE_EXIT);
    expect(twin.out).toMatchObject({ flake: { id: "f1" }, stable: false });
    await client.close();
  }, 60_000);

  test("check_flake on a stable shot equals `flake --json`", async () => {
    const cwd = await project();
    const client = await connected(cwd);
    const body = json(await tool(client, "check_flake", { flake_id: "f2", runs: "2" }));
    expect(body).toMatchObject({ stable: true, resolved: null });
    expect(body).toEqual((await cli(cwd, flakeArgs("f2", "--runs", "2"))).out);
    await client.close();
  }, 60_000);

  test("suggest_ignore returns the ignore area as an edit, and leaves the config as it was", async () => {
    const cwd = await project();
    const path = join(cwd, "pixelslash.config.json");
    const before = await Bun.file(path).text();
    const client = await connected(cwd);
    const r = await tool(client, "suggest_ignore", { flake_id: "f1", runs: "3" });
    const body: { edits: { set: string | null }[] } = JSON.parse(text(r));
    expect(body).toMatchObject({ stable: false, editable: true, written: false });
    const { edits } = body;
    expect(edits.some((e) => e.set?.includes("ignore"))).toBe(true);
    expect(await Bun.file(path).text()).toBe(before);
    const twin = await cli(cwd, flakeArgs("f1", "--runs", "3", "--suggest"));
    expect(twin.out).toMatchObject({ stable: false, written: false });
    expect(await Bun.file(path).text()).toBe(before);
    await client.close();
  }, 60_000);

  test("resolve_flake resolves a stable shot, and sends nothing for an unstable one", async () => {
    const [cwd, api] = [await project(), server()];
    const client = await connected(cwd, api);
    const unstable = json(await tool(client, "resolve_flake", { flake_id: "f1", runs: "3" }));
    expect(unstable).toMatchObject({ stable: false, resolved: false });
    expect(api.seen.some((s) => s.method === "POST")).toBe(false);
    const fixed = json(
      await tool(client, "resolve_flake", { flake_id: "f2", runs: "2", note: "fonts pinned" }),
    );
    expect(fixed).toMatchObject({ stable: true, resolved: true });
    expect(api.seen.filter((s) => s.method === "POST").map((s) => s.path)).toEqual([
      "/api/v1/flakes/f2/resolve",
    ]);
    const twin = await cli(
      cwd,
      flakeArgs("f2", "--runs", "2", "--resolve", "--note", "fonts pinned"),
    );
    expect(twin.code).toBe(0);
    expect(fixed).toEqual(twin.out);
    expect(
      (await tool(client, "resolve_flake", { flake_id: "f2", note: "x".repeat(201) })).isError,
    ).toBe(true);
    await client.close();
  }, 60_000);

  test("a long run reports progress per shot", async () => {
    const cwd = await project();
    const client = await connected(cwd);
    const seen: Progress[] = [];
    await client.callTool(
      { name: "check_flake", arguments: { flake_id: "f2", runs: "3" } },
      CallToolResultSchema,
      { onprogress: (p) => seen.push(p) },
    );
    expect(seen.map((p) => [p.progress, p.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    await client.close();
  }, 60_000);

  test("a cancelled run takes no further shot, and the server keeps serving", async () => {
    let loads = 0;
    const page = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname === "/") loads++;
        return new Response(Bun.file(join(PAGES, "live.html")), {
          headers: { "content-type": "text/html" },
        });
      },
    });
    try {
      const cwd = await project(`http://127.0.0.1:${page.port}`);
      const client = await connected(cwd);
      const stop = new AbortController();
      const cancelled = client.callTool(
        { name: "check_flake", arguments: { flake_id: "f2", runs: "20" } },
        CallToolResultSchema,
        { signal: stop.signal, onprogress: () => stop.abort(new Error("enough")) },
      );
      await expect(cancelled).rejects.toThrow("enough");
      const atCancel = loads;
      await Bun.sleep(3000);
      // The shot in the browser when the cancel came may finish; nothing after it starts.
      expect(loads - atCancel).toBeLessThanOrEqual(1);
      expect(await Bun.file(join(cwd, "pixelslash-flake", "report.html")).exists()).toBe(false);
      expect((await tool(client, "capture_local", { only: "index" })).isError).toBeFalsy();
      await client.close();
    } finally {
      await page.stop(true);
    }
  }, 60_000);

  test("the twins' usage errors exit 2", async () => {
    const cwd = await project();
    for (const more of [
      ["--write", "--json"],
      ["--write", "--suggest"],
      ["--suggest", "--resolve"],
    ]) {
      const cap = capture();
      expect(
        await run(flakeArgs("f1", ...more), cap.io, { ...base, fetch: server().fetch, cwd }),
      ).toBe(2);
    }
  });
});

describe("pixelslash mcp: the local fix loop over stdio", () => {
  test("a client spawning the bin captures a route and checks a flake against a served API", async () => {
    const [cwd, api] = [await project(), server()];
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.method === "POST" ? await req.text() : undefined;
        return api.fetch(`${SERVER}${url.pathname}`, { method: req.method, ...(body && { body }) });
      },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        "mcp",
        "--server",
        `http://127.0.0.1:${http.port}`,
      ],
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(transport);
      const shot = await tool(client, "capture_local", { only: ["index"] });
      expect(shot.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
      const body = json(await tool(client, "check_flake", { flake_id: "f2", runs: "2" }));
      expect(body).toMatchObject({ stable: true });
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).toSorted()).toEqual([
        "build-to-spec",
        "explain-build",
        "fix-flake",
      ]);
      const fix = await client.getPrompt({ name: "fix-flake", arguments: { flake_id: "f1" } });
      expect(JSON.stringify(fix.messages)).toContain("suggest_ignore");
    } finally {
      await client.close();
      await http.stop(true);
    }
  }, 60_000);
});
