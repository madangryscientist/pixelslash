import { CLIENT_VERSION, UsageError } from "@pixelslash/engine";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { RemoteError, isObj, str, type Reply } from "./api.ts";
import { readFlagPairs } from "./args.ts";
import {
  REMOTE_FLAGS,
  connect,
  resolveProject,
  type Remote,
  type RemoteDeps,
  type RemoteFlags,
} from "./remote.ts";
import type { Io } from "./run.ts";

export const MCP_USAGE = `pixelslash mcp [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE]
A stdio MCP server for a coding agent: it reads builds, snapshots, flakes and detection flags. It
accepts and rejects nothing. Add it with \`claude mcp add pixelslash -- pixelslash mcp\`.`;

type Args = Record<string, unknown>;
type Fetch = NonNullable<RemoteDeps["fetch"]>;
/** What a tool call runs against: the connection, `--project`, and the fetch for images. */
type Ctx = { remote: Remote; project: string | undefined; fetch: Fetch };
type Tool = {
  description: string;
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required?: string[];
  call: (ctx: Ctx, args: Args) => Promise<CallToolResult>;
};

const PROJECT = {
  type: "string",
  description:
    "Project id or name. Optional when --project, upload.project or a single visible project names it.",
};
const LIMIT = { type: "string", description: "Rows per page, 1 to 100 (the API defaults to 50)." };
const CURSOR = { type: "string", description: "The previous page's next_cursor." };
const SNAPSHOT_ID = { type: "string", description: "A snapshot id, from get_build." };

const STATUSES = ["uploading", "processing", "changes", "passed", "failed", "errored"];
const IMAGES = ["head", "baseline", "diff"] as const;

/** A string argument, or undefined when absent. Anything else is a usage error. */
function arg(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new UsageError(`${name} must be a string`);
}

function need(args: Args, name: string): string {
  const v = arg(args, name);
  if (v === undefined) throw new UsageError(`${name} is required`);
  return v;
}

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const reply = (r: Reply): CallToolResult => text(r.text);
const id = (v: string) => encodeURIComponent(v);

async function projectId({ remote, project }: Ctx, args: Args): Promise<string> {
  return id((await resolveProject(remote, arg(args, "project") ?? project)).id);
}

/** A signed image URL, fetched only when it is on the configured server. */
async function image({ remote, fetch }: Ctx, url: string): Promise<string> {
  if (new URL(url).origin !== new URL(remote.client.server).origin)
    throw new RemoteError(`image ${url} is not on ${remote.client.server}; not fetched`);
  const res = await fetch(url).catch((e: unknown) => {
    throw new RemoteError(`cannot fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new RemoteError(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

/** `get_snapshot_images`: the PNGs the snapshot has, each after a line naming it. */
async function snapshotImages(ctx: Ctx, args: Args): Promise<CallToolResult> {
  const sid = need(args, "snapshot_id");
  const which = arg(args, "which");
  if (which !== undefined && !IMAGES.some((w) => w === which))
    throw new UsageError(`which must be one of ${IMAGES.join(", ")}`);
  const { body } = await ctx.remote.client.get(`/api/v1/snapshots/${id(sid)}`);
  const images = isObj(body.snapshot) && isObj(body.snapshot.images) ? body.snapshot.images : {};
  const content: CallToolResult["content"] = [];
  for (const name of IMAGES) {
    if (which !== undefined && which !== name) continue;
    const url = str(images[name]);
    if (!url) {
      content.push({ type: "text", text: `${name}: none` });
      continue;
    }
    content.push({ type: "text", text: `${name}:` });
    content.push({ type: "image", mimeType: "image/png", data: await image(ctx, url) });
  }
  return { content };
}

const TOOLS: Record<string, Tool> = {
  whoami: {
    description: "The server, where the token came from, and who it acts as (GET /api/v1/me).",
    properties: {},
    call: async ({ remote }) => {
      const me = await remote.client.get("/api/v1/me");
      return text(JSON.stringify({ server: remote.client.server, via: remote.via, me: me.body }));
    },
  },
  list_projects: {
    description: "The projects the token can read, with their ids (GET /api/v1/projects).",
    properties: {},
    call: async ({ remote }) => reply(await remote.client.get("/api/v1/projects")),
  },
  list_builds: {
    description:
      "A project's builds, newest first, with counts per group and review state (GET /api/v1/projects/:id/builds).",
    properties: {
      project: PROJECT,
      branch: { type: "string", description: "Only builds of this branch." },
      status: { type: "string", description: "Only builds in this status.", enum: STATUSES },
      limit: LIMIT,
      cursor: CURSOR,
    },
    call: async (ctx, args) => {
      const pid = await projectId(ctx, args);
      return reply(
        await ctx.remote.client.get(`/api/v1/projects/${pid}/builds`, {
          branch: arg(args, "branch"),
          status: arg(args, "status"),
          limit: arg(args, "limit"),
          cursor: arg(args, "cursor"),
        }),
      );
    },
  },
  get_build: {
    description:
      "One build: counts, and every snapshot in review order with its group, diff numbers, regions, review state, and carried_from / approved_earlier (GET /api/v1/builds/:id).",
    properties: { build_id: { type: "string", description: "A build id, from list_builds." } },
    required: ["build_id"],
    call: async ({ remote }, args) =>
      reply(await remote.client.get(`/api/v1/builds/${id(need(args, "build_id"))}`)),
  },
  get_snapshot: {
    description:
      "One snapshot's record, with signed image URLs that expire after 5 minutes. No pixels; use get_snapshot_images for those (GET /api/v1/snapshots/:id).",
    properties: { snapshot_id: SNAPSHOT_ID },
    required: ["snapshot_id"],
    call: async ({ remote }, args) =>
      reply(await remote.client.get(`/api/v1/snapshots/${id(need(args, "snapshot_id"))}`)),
  },
  get_snapshot_images: {
    description:
      "The snapshot's head, baseline and diff PNGs, as images. They are page shots: calling this hands them to the model you run.",
    properties: {
      snapshot_id: SNAPSHOT_ID,
      which: {
        type: "string",
        description: "One image only; all three that exist when absent.",
        enum: [...IMAGES],
      },
    },
    required: ["snapshot_id"],
    call: snapshotImages,
  },
  list_flakes: {
    description:
      "A project's flaky shots, open first, with the evidence of each detection: runs, which differed, regions (GET /api/v1/projects/:id/flakes).",
    properties: { project: PROJECT },
    call: async (ctx, args) => {
      const pid = await projectId(ctx, args);
      return reply(await ctx.remote.client.get(`/api/v1/projects/${pid}/flakes`));
    },
  },
  list_detection_flags: {
    description:
      "The mis-detections reviewers flagged on a project's snapshots, newest first: `missed` or `false_positive`, with the box drawn (GET /api/v1/projects/:id/detection-flags).",
    properties: { project: PROJECT, limit: LIMIT, cursor: CURSOR },
    call: async (ctx, args) => {
      const pid = await projectId(ctx, args);
      return reply(
        await ctx.remote.client.get(`/api/v1/projects/${pid}/detection-flags`, {
          limit: arg(args, "limit"),
          cursor: arg(args, "cursor"),
        }),
      );
    },
  },
};

/**
 * The MCP server over `flags`' server and token. It connects on each call, so a server that is
 * down or a token that is missing is a tool error the agent can read, not a server that will not start.
 */
export function mcpServer(flags: RemoteFlags, deps: RemoteDeps = {}): Server {
  const fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const server = new Server(
    { name: "pixelslash", version: CLIENT_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: { type: "object", properties: t.properties, required: t.required },
      annotations: { readOnlyHint: true, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS[req.params.name];
    if (!tool) return { ...text(`unknown tool: ${req.params.name}`), isError: true };
    try {
      const remote = await connect(flags, { ...deps, fetch });
      return await tool.call({ remote, project: flags.project, fetch }, req.params.arguments ?? {});
    } catch (e) {
      if (e instanceof UsageError || e instanceof RemoteError)
        return { ...text(e.message), isError: true };
      throw e;
    }
  });
  return server;
}

/** `pixelslash mcp`: serve on stdin/stdout until the client closes stdin. Nothing else goes to stdout. */
export async function runMcp(argv: string[], io: Io, deps: RemoteDeps = {}): Promise<number> {
  const flags = readFlagPairs(argv, [...REMOTE_FLAGS, "project"]);
  const server = mcpServer(flags, deps);
  // The SDK's stdio transport does not watch for the end of stdin; the client hanging up is it.
  const ended = new Promise((done) => process.stdin.once("end", done));
  await server.connect(new StdioServerTransport());
  io.stderr.write("pixelslash mcp: serving on stdio\n");
  await ended;
  await server.close();
  return 0;
}
