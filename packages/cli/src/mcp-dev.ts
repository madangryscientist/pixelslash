import {
  type DevIteration,
  type DevLock,
  UsageError,
  inlinePng,
  liveSession,
} from "@hackcove/pixelslash-engine";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { RemoteError } from "./api.ts";
import { REMOTE_FLAGS } from "./remote.ts";
import { type DevDeps, iterationJson, latestOf, parseDevArgs, pinOf, storeOf } from "./dev.ts";
import { runThrough } from "./dev-attach.ts";
import { type LiveSession, firstRun, onceInProgress, startSession } from "./dev-loop.ts";
import { specJson, specOf } from "./dev-spec.ts";
import type { Io } from "./run.ts";

/**
 * Feature mode over MCP (ob 1742): `pixelslash dev` for the user's coding agent. Each tool is the
 * `pixelslash dev … --json` twin's function, and its first text is that twin's JSON; pixels follow
 * as images, at most 1024 px wide. The session is the one of the worktree the server runs in.
 * Pinning is the only state an agent changes, and it is local: nothing is accepted or uploaded.
 */

type Args = Record<string, unknown>;
type Schema = { type: string; description: string; enum?: string[] };

type DevTool = {
  description: string;
  properties: Record<string, Schema>;
  annotations: ToolAnnotations;
  call: (args: Args) => Promise<CallToolResult>;
};

/** The `pixelslash mcp` flags; a dev session uses them as its twin would. */
export const MCP_FLAGS = [...REMOTE_FLAGS, "project", "base", "figma-token-path"] as const;
type McpFlags = Partial<Record<(typeof MCP_FLAGS)[number], string>>;

/** A string argument, or undefined when absent. Anything else is a usage error. */
export function arg(args: Args, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw new UsageError(`${name} must be a string`);
}

function on(args: Args, name: string): boolean {
  const v = args[name];
  if (v === undefined || v === null || v === false || v === "false") return false;
  if (v === true || v === "true") return true;
  throw new UsageError(`${name} must be true or false`);
}

export const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const DATA_URL = "data:image/png;base64,";

/** A labelled PNG, scaled to at most 1024 px wide. */
export async function picture(label: string, file: string): Promise<CallToolResult["content"]> {
  const data = (await inlinePng(file)).slice(DATA_URL.length);
  return [
    { type: "text", text: label },
    { type: "image", mimeType: "image/png", data },
  ];
}

/** The twin's JSON, then each shot and its diff as images. */
async function iterationResult(it: DevIteration, url: string | null): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [
    { type: "text", text: pretty(iterationJson(it, url)) },
  ];
  for (const s of it.shots) {
    const at = `${s.name} (${s.shot})`;
    if (s.files.shot) content.push(...(await picture(`${at} shot:`, s.files.shot)));
    if (s.files.diff) content.push(...(await picture(`${at} diff:`, s.files.diff)));
  }
  return { content };
}

const TARGET = { type: "string", description: "A route or story name from the config." };
const ID = { type: "string", description: "An iteration id (7 or 000007)." };
const VIEWPORT = { type: "string", description: "Only this variant: a WxH or a variant name." };
const THEME = { type: "string", description: "Only this theme.", enum: ["light", "dark"] };
const CHECK = "After each edit, call dev_run, or wait for the save to run and call dev_latest.";

export const LOCAL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** What every dev tool of one server shares: its flags and the session it started. */
type Ctx = {
  flags: McpFlags;
  deps: DevDeps;
  io: Io;
  live: LiveSession | undefined;
};

/** The live session's page; a `--once` run has none. */
async function sessionUrl(ctx: Ctx): Promise<string> {
  const owner = await liveSession(await storeOf(ctx.deps));
  if (!owner) throw new UsageError("no pixelslash dev session in this worktree; call dev_start");
  if (owner.url === null) onceInProgress(owner.pid);
  return owner.url;
}

/** `dev_start`'s arguments and the server's flags, as `pixelslash dev` argv. */
function startArgv(args: Args, flags: McpFlags): string[] {
  const argv: string[] = [];
  const target = arg(args, "target");
  if (target !== undefined) argv.push(target);
  for (const name of ["url", "viewport", "theme", "against", "ds"]) {
    const v = arg(args, name);
    if (v !== undefined) argv.push(`--${name}`, v);
  }
  for (const [name, v] of Object.entries(flags)) if (v !== undefined) argv.push(`--${name}`, v);
  if (on(args, "judge")) argv.push("--judge");
  return argv;
}

async function start(ctx: Ctx, args: Args): Promise<CallToolResult> {
  const dev = parseDevArgs(startArgv(args, ctx.flags));
  const store = await storeOf(ctx.deps);
  const attach = (owner: DevLock) => {
    if (owner.url === null) onceInProgress(owner.pid);
    if (dev.target !== undefined && dev.target !== owner.target)
      throw new UsageError(
        `this worktree's session is on ${owner.target}, not ${dev.target}; dev_stop it (or quit it in its terminal) first`,
      );
    const by = ctx.live?.url === owner.url ? "this server" : `pid ${owner.pid}`;
    return text(pretty({ started: false, target: owner.target, page: owner.url, by }));
  };
  const owner = await liveSession(store);
  if (owner) return attach(owner);
  const started = await startSession(store, dev, ctx.io, ctx.deps);
  if (!started.held) return attach(started.owner);
  const live = started.live;
  ctx.live = live;
  await firstRun(live, ctx.io);
  return text(pretty({ started: true, target: live.target, page: live.url, by: "this server" }));
}

async function runNow(ctx: Ctx): Promise<CallToolResult> {
  const url = await sessionUrl(ctx);
  const it = await runThrough(url);
  if (!it) throw new RemoteError("the session's run failed; its terminal says why");
  return iterationResult(it, url);
}

async function spec(ctx: Ctx, args: Args): Promise<CallToolResult> {
  const { target, feature } = await specOf(
    {
      named: arg(args, "target"),
      flags: {
        config: ctx.flags.config,
        "figma-token-path": ctx.flags["figma-token-path"],
        viewport: arg(args, "viewport"),
        theme: arg(args, "theme"),
      },
      refresh: on(args, "refresh_refs"),
      root: (await storeOf(ctx.deps)).root,
    },
    ctx.deps,
  );
  const json = await specJson(target, feature);
  // The images go as images, not as base64 in the text: `image` says where.
  const refs = json.refs.map((r, i) => ({ ...r, image: r.image ? `image ${i}` : null }));
  const content: CallToolResult["content"] = [{ type: "text", text: pretty({ ...json, refs }) }];
  for (const [i, r] of feature.refs.entries())
    if (r.file) content.push(...(await picture(`image ${i}: ${r.variant} ${r.theme}`, r.file)));
  return { content };
}

async function stop(ctx: Ctx): Promise<CallToolResult> {
  if (ctx.live) {
    const { target, url } = ctx.live;
    await ctx.live.stop();
    ctx.live = undefined;
    return text(pretty({ stopped: true, target, page: url }));
  }
  const owner = await liveSession(await storeOf(ctx.deps));
  if (owner)
    throw new UsageError(
      `the session on ${owner.target} (pid ${owner.pid}) was not started by this server; quit it in its terminal`,
    );
  return text(pretty({ stopped: false }));
}

const START_PROPS: Record<string, Schema> = {
  target: TARGET,
  url: { type: "string", description: "Shoot this URL instead of a named target." },
  viewport: VIEWPORT,
  theme: THEME,
  against: {
    type: "string",
    description: "Compare with the previous iteration (default) or main's baselines.",
    enum: ["previous", "main"],
  },
  judge: {
    type: "boolean",
    description:
      "List how each shot differs from the target's spec and refs (needs a local judge).",
  },
  ds: { type: "string", description: "With judge: the design system's rasters dir." },
};

function table(ctx: Ctx): Record<string, DevTool> {
  const pin = (yes: boolean) => async (args: Args) =>
    text(pretty((await pinOf(await storeOf(ctx.deps), yes, arg(args, "id"))).out));
  return {
    dev_start: {
      description: `Start this worktree's pixelslash dev session on a target, or attach to the one running, and return its live page URL (show it to the user: it draws every iteration). The app must already be up. The session re-shoots on every save. ${CHECK}`,
      properties: START_PROPS,
      annotations: { ...LOCAL, openWorldHint: true },
      call: (args) => start(ctx, args),
    },
    dev_run: {
      description: `Shoot the target now, through the session, and return the iteration: regions, counts, timings, the judge's differences, and each shot and diff as images. ${CHECK}`,
      properties: {},
      annotations: LOCAL,
      call: () => runNow(ctx),
    },
    dev_latest: {
      description: `The latest iteration, without shooting: regions, counts, timings, file paths, the judge's differences, and each shot and diff as images (at most 1024 px wide). ${CHECK}`,
      properties: { target: TARGET },
      annotations: READ,
      call: async (args) => {
        const found = await latestOf(await storeOf(ctx.deps), arg(args, "target"));
        if (!found) throw new UsageError("no iteration yet; call dev_start or dev_run");
        return iterationResult(found.it, found.url);
      },
    },
    dev_pin: {
      description:
        "Pin an iteration (the latest when no id) so the next runs compare with it. Pins are local to this worktree; nothing is accepted or uploaded.",
      properties: { id: ID },
      annotations: LOCAL,
      call: pin(true),
    },
    dev_unpin: {
      description: "Remove a pin (the newest when no id).",
      properties: { id: ID },
      annotations: LOCAL,
      call: pin(false),
    },
    dev_spec: {
      description:
        "The target's spec text and its reference images (repo PNGs or Figma frames): the paths, then each ref as an image at most 1024 px wide. Read it before editing.",
      properties: {
        target: TARGET,
        viewport: VIEWPORT,
        theme: THEME,
        refresh_refs: { type: "boolean", description: "Fetch the Figma refs again." },
      },
      annotations: { ...READ, openWorldHint: true },
      call: (args) => spec(ctx, args),
    },
    dev_stop: {
      description:
        "Stop the dev session this server started. A session started in a terminal is left running.",
      properties: {},
      annotations: LOCAL,
      call: () => stop(ctx),
    },
  };
}

/**
 * The dev tools of one MCP server. A session this server started lives as long as the server
 * does; `close` ends it. A session started in a terminal is driven through its page, never stopped.
 */
export function devTools(
  flags: McpFlags,
  deps: DevDeps,
  log: Io["stderr"],
): { tools: Record<string, DevTool>; close: () => Promise<void> } {
  // The session's lines go to stderr: stdout is the MCP channel.
  const ctx: Ctx = { flags, deps, io: { stdout: log, stderr: log }, live: undefined };
  return {
    tools: table(ctx),
    close: async () => {
      await ctx.live?.stop();
      ctx.live = undefined;
    },
  };
}

/** `build-to-spec`: the loop an agent runs with the tools above. */
export function buildToSpec(target: string | undefined): string {
  const t = target ?? "the target";
  const named = target ? ` with target "${target}"` : "";
  return `Build ${t} to its spec with pixelslash's dev tools.

1. Call dev_spec${named}. Read the spec and look at every reference image.
2. Call dev_start${named}. Give the user its live page URL: it shows every iteration.
3. Edit the code toward the spec and references.
4. Call dev_run (or dev_latest once the save has run). Look at each shot beside the references, and read "differences" when the judge ran.
5. Repeat 3 and 4 until the shot matches. Say plainly what still differs; never claim a match you have not seen in a shot.
6. When it matches, call dev_pin so later runs compare with it, then dev_stop.

Pinning is local to this worktree. Never accept, reject or upload anything: there is no tool for it, and that decision is the user's.`;
}
