import { resolve } from "node:path";
import { UsageError } from "@pixelslash/engine";
import type {
  CallToolResult,
  ServerNotification,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { captureJson, captureLocal } from "./capture.ts";
import { type CheckFlags, checkJson, checkLocal } from "./check.ts";
import type { DevDeps } from "./dev.ts";
import {
  type FlakeFlags,
  checkNote,
  flakeJson,
  reproduceFlake,
  resolveFlake,
  suggestJson,
} from "./flake.ts";
import { LOCAL, MCP_FLAGS, arg, picture, pretty } from "./mcp-dev.ts";
import type { Io } from "./run.ts";
import type { Watch } from "./watch.ts";

/**
 * The local fix loop over MCP (ob 1735): check, capture, reproduce a flake, suggest an ignore,
 * resolve. Each tool is its `--json` CLI twin's function, and its first text is that twin's JSON.
 * Shots are taken here and stay here; the server is only read, except by `resolve_flake`, which
 * marks a flake resolved only when this machine's run was stable. No tool writes the config.
 */

type Args = Record<string, unknown>;
type Schema = { type: string | string[]; description: string; items?: { type: string } };
type McpFlags = Partial<Record<(typeof MCP_FLAGS)[number], string>>;
/** What a call runs with: the server's flags, the worktree, and where the session's lines go. */
type Ctx = { flags: McpFlags; deps: DevDeps; cwd: string; warn: (m: string) => void };

type LocalTool = {
  description: string;
  properties: Record<string, Schema>;
  required?: string[];
  annotations: ToolAnnotations;
  call: (ctx: Ctx, args: Args, watch: Watch) => Promise<CallToolResult>;
};

/** A name or a list of names; the tools' `only`. */
function names(args: Args, name: string): string[] | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  const list: unknown[] = Array.isArray(v) ? v : [v];
  if (!list.every((n): n is string => typeof n === "string" && n !== ""))
    throw new UsageError(`${name} must be a name or a list of names`);
  return list;
}

/** The flags with the arguments given set; an absent argument leaves the flag as it was. */
function withArgs<F extends Record<string, string>>(
  flags: F,
  set: Record<string, string | undefined>,
): F {
  const given = Object.entries(set).filter((e): e is [string, string] => e[1] !== undefined);
  return { ...flags, ...Object.fromEntries(given) };
}

const json = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: pretty(v) }] });

function reproduce(ctx: Ctx, args: Args, watch: Watch) {
  const id = arg(args, "flake_id");
  if (!id) throw new UsageError("flake_id is required");
  const flags = withArgs<FlakeFlags>(ctx.flags, { runs: arg(args, "runs"), out: arg(args, "out") });
  return reproduceFlake(id, flags, {
    ...ctx.deps,
    cwd: ctx.cwd,
    watch,
    warn: ctx.warn,
    started: ctx.warn,
  });
}

async function checkTool(ctx: Ctx, args: Args, watch: Watch): Promise<CallToolResult> {
  const flags = withArgs<CheckFlags>(ctx.flags, {
    base: arg(args, "base"),
    out: arg(args, "out"),
    "flake-retries": arg(args, "flake_retries"),
  });
  const deps = { ...ctx.deps, cwd: ctx.cwd, warn: ctx.warn };
  return json(checkJson(await checkLocal(flags, names(args, "only"), deps, watch)));
}

async function captureTool(ctx: Ctx, args: Args, watch: Watch): Promise<CallToolResult> {
  const only = names(args, "only");
  if (!only) throw new UsageError("only is required: name a route or story");
  const out = resolve(ctx.cwd, arg(args, "out") ?? "pixelslash-snapshots");
  const deps = { ...ctx.deps, cwd: ctx.cwd, warn: ctx.warn };
  const body = captureJson(
    out,
    await captureLocal({ config: ctx.flags.config, out, only }, deps, watch),
  );
  const content: CallToolResult["content"] = [{ type: "text", text: pretty(body) }];
  for (const s of body.shots) content.push(...(await picture(`${s.name} (${s.variant}):`, s.file)));
  return { content };
}

async function resolveTool(ctx: Ctx, args: Args, watch: Watch): Promise<CallToolResult> {
  const note = arg(args, "note");
  checkNote(note, true);
  const r = await reproduce(ctx, args, watch);
  return json(flakeJson(r, await resolveFlake(r, note)));
}

const FLAKE_ID = { type: "string", description: "A flake id, from list_flakes." };
const RUNS = {
  type: "string",
  description: "How many times to capture the shot, 2 to 20 (default 5).",
};
const out = (dir: string) => ({
  type: "string",
  description: `Where the shots and report go, relative to the worktree (default ${dir}).`,
});
const ONLY = {
  type: ["string", "array"],
  items: { type: "string" },
  description: "Route or story names from the config; all when absent.",
};
const FLAKE = { flake_id: FLAKE_ID, runs: RUNS, out: out("pixelslash-flake") };

const TOOLS: Record<string, LocalTool> = {
  check_local: {
    description:
      "Capture the config's routes here (the app must already be up) and compare each with the baseline the server would pick for this commit. Nothing is uploaded. Returns every shot's status and changed regions, and the report's path. The `pixelslash check --json` twin.",
    properties: {
      only: ONLY,
      base: { type: "string", description: "The base branch (default upload.baseBranch or main)." },
      flake_retries: { type: "string", description: "Recapture a changed shot up to N times." },
      out: out("pixelslash-check"),
    },
    annotations: { ...LOCAL, openWorldHint: true },
    call: checkTool,
  },
  capture_local: {
    description:
      "Capture one route or story (or the ones named) here, every variant, and return each PNG's path and the PNG itself. Nothing is uploaded or compared. The `pixelslash capture --only NAME --json` twin.",
    properties: { only: ONLY, out: out("pixelslash-snapshots") },
    required: ["only"],
    annotations: LOCAL,
    call: captureTool,
  },
  check_flake: {
    description:
      "Reproduce a flake here: capture its shot `runs` times against the running app and diff each run with the first. Returns stable or not, what differed and where, the suggested fixes and a report. Nothing is uploaded. The `pixelslash flake ID --json` twin.",
    properties: FLAKE,
    required: ["flake_id"],
    annotations: LOCAL,
    call: async (ctx, args, watch) => json(flakeJson(await reproduce(ctx, args, watch), null)),
  },
  suggest_ignore: {
    description:
      'Reproduce a flake here and return the suggested config changes (an ignore area, a stabilise setting, flaky: "skip") as edits, with exactly what each sets. Nothing is written: show the edit to the user and let them make it. The `pixelslash flake ID --suggest --json` twin.',
    properties: FLAKE,
    required: ["flake_id"],
    annotations: LOCAL,
    call: async (ctx, args, watch) => json(await suggestJson(await reproduce(ctx, args, watch))),
  },
  resolve_flake: {
    description:
      "Reproduce a flake here and, only if every run rendered the same, mark it resolved on the server. An unstable run sends nothing and returns resolved: false. The `pixelslash flake ID --resolve --json` twin.",
    properties: {
      ...FLAKE,
      note: { type: "string", description: "Why it is fixed, at most 200 characters." },
    },
    required: ["flake_id"],
    annotations: { ...LOCAL, idempotentHint: true, openWorldHint: true },
    call: resolveTool,
  },
};

/** The local tools, bound to the server's flags and worktree. */
export function localTools(flags: McpFlags, deps: DevDeps, log: Io["stderr"]) {
  const ctx: Ctx = {
    flags,
    deps,
    cwd: deps.cwd ?? process.cwd(),
    warn: (m) => log.write(`${m}\n`),
  };
  return Object.fromEntries(
    Object.entries(TOOLS).map(([name, { call, ...t }]) => [
      name,
      { ...t, call: (args: Args, watch: Watch) => call(ctx, args, watch) },
    ]),
  );
}

type Extra = {
  signal: AbortSignal;
  sendNotification: (n: ServerNotification) => Promise<void>;
};

/** A long tool's progress, one notification per shot when the client asked, and its cancellation. */
export function watchOf(
  params: { _meta?: { progressToken?: string | number | undefined } | undefined },
  extra: Extra,
): Watch {
  const token = params["_meta"]?.progressToken;
  if (token === undefined) return { signal: extra.signal };
  return {
    signal: extra.signal,
    progress: ({ done, total, message }) =>
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: done, message, ...(total && { total }) },
        })
        .catch(() => {}),
  };
}
