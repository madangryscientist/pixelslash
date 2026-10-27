import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { UsageError } from "@pixelslash/engine";
import { buildToSpec } from "./mcp-dev.ts";

/**
 * The local fix loop as MCP prompts (ob 1735): what an agent does with the local tools, in order.
 * `docs/cli.md`'s "Using PixelSlash from your agent" says the same.
 */

type LoopPrompt = {
  description: string;
  /** The description `prompts/get` answers with; `description` when absent. */
  title?: (value: string | undefined) => string;
  argument: { name: string; description: string; required: boolean };
  text: (value: string | undefined) => string;
};

const NEVER = `Never accept, reject or upload anything, and never edit pixelslash.config.json yourself: there is no tool for it, and those decisions are the user's. Show the user a suggested edit and let them make it.`;

/** The fix loop the local tools exist for: read, reproduce here, change, re-check, resolve. */
const PROMPTS: Record<string, LoopPrompt> = {
  "build-to-spec": {
    description:
      "Build a page or component to its spec and references with the dev tools: spec, edit, run, read the differences, repeat, pin.",
    title: (target) => `Build ${target ?? "the target"} to its spec`,
    argument: {
      name: "target",
      description: "A route or story name from the config with a features entry.",
      required: false,
    },
    text: buildToSpec,
  },
  "fix-flake": {
    description:
      "Fix a flaky shot: read the flake, reproduce it here, change the page or suggest an ignore, re-check, resolve.",
    argument: { name: "flake_id", description: "A flake id from list_flakes.", required: false },
    text: (id) => {
      const flake = id ? `flake ${id}` : "the flake (call list_flakes and ask the user which one)";
      const named = id ? ` with flake_id "${id}"` : "";
      return `Fix ${flake} with pixelslash's local tools. The app must already be running at the config's baseUrl.

1. Read: call list_flakes and find it: its shot, browser, viewport and theme, and the builds it differed in.
2. Reproduce: call check_flake${named}. It captures the shot several times here and diffs each run with the first. Read "stable", "differed", each run's "regions" and "causes", and open "report".
3. Change: if the difference comes from the page (an animation, a timestamp, random content, a late font or image), fix the code so it renders the same every time. If it is content that is meant to change, call suggest_ignore${named} and show the user the edit it returns (the ignore area, or a stabilise setting); the user makes the edit.
4. Re-check: call check_flake${named} again. Repeat 3 and 4 until it is stable. Say plainly if it is still unstable; never claim a fix a run has not shown.
5. Resolve: when it is stable, call resolve_flake${named} with a short note on what fixed it. It resolves only after a stable run here.

${NEVER}`;
    },
  },
  "explain-build": {
    description:
      "Explain a build's changes and reproduce the ones that matter here: read, check locally, change, re-check.",
    argument: { name: "build_id", description: "A build id from list_builds.", required: false },
    text: (id) => {
      const build = id ? `build ${id}` : "the latest build on this branch (call list_builds)";
      return `Explain ${build} to the user, then help fix what needs fixing.

1. Read: call get_build${id ? ` with build_id "${id}"` : ""}. For each changed shot, call get_snapshot and get_snapshot_images, and say what changed in a sentence. Name flaky shots as flaky, not as changes.
2. Reproduce: call check_local with only the changed shots' names. It captures them here and compares with the same baselines the server used; nothing is uploaded. capture_local takes one shot when only the picture is needed.
3. Change: if a change is a regression, fix the code. If a shot is flaky, follow the fix-flake prompt for its flake.
4. Re-check: call check_local again and compare the shots' status and regions with the last run.
5. Report what is fixed, what still differs, and what is an intended change the user should accept on the server.

${NEVER}`;
    },
  },
};

/** `prompts/list` and `prompts/get` for the prompts above. */
export function servePrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: Object.entries(PROMPTS).map(([name, p]) => ({
      name,
      description: p.description,
      arguments: [p.argument],
    })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, (req) => {
    const prompt = PROMPTS[req.params.name];
    if (!prompt) throw new UsageError(`unknown prompt: ${req.params.name}`);
    const value = req.params.arguments?.[prompt.argument.name] || undefined;
    return {
      description: prompt.title?.(value) ?? prompt.description,
      messages: [{ role: "user", content: { type: "text", text: prompt.text(value) } }],
    };
  });
}
