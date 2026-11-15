import { UsageError } from "@hackcove/pixelslash-engine";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { arg, text } from "./mcp-dev.ts";
import type { Remote } from "./remote.ts";

/**
 * The two MCP tools that decide a review, each one call to its `/api/v1` endpoint, whose text is
 * the API's reply as sent. The server does what the web app's buttons do; only a personal token may
 * decide, and the decision is recorded under its user.
 */

type Args = Record<string, unknown>;

/** A review decision: it writes, but undoes nothing a person cannot decide again. */
const DECIDES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** Said by both tools, so the agent looks before it decides. */
const DECISION =
  "The decision is recorded under the token's user, as if they clicked it in the web app, and moves the PR's PixelSlash status. Look at the images (get_snapshot_images) first. Needs a personal token: a CI or org token is refused (403).";

function need(args: Args, name: string): string {
  const v = arg(args, name);
  if (v === undefined) throw new UsageError(`${name} is required`);
  return v;
}

const id = (v: string) => encodeURIComponent(v);
const STATES = ["accepted", "rejected"];

export const REVIEW_TOOLS = {
  review_snapshot: {
    description: `Accept or reject one snapshot of a build, as the web app's buttons do; the decision reaches the other builds that carry the same change. Answers the build's verdict and the ids of the builds it moved, the decided one first. ${DECISION} (POST /api/v1/snapshots/:id/review).`,
    properties: {
      snapshot_id: { type: "string", description: "A snapshot id, from get_build." },
      state: { type: "string", description: "The decision.", enum: STATES },
    },
    required: ["snapshot_id", "state"],
    annotations: DECIDES,
    call: async ({ remote }: { remote: Remote }, args: Args): Promise<CallToolResult> => {
      const path = `/api/v1/snapshots/${id(need(args, "snapshot_id"))}/review`;
      return text((await remote.client.post(path, { state: need(args, "state") })).text);
    },
  },
  accept_build: {
    description: `Accept every shot of a build, as the web app's Accept all does. A skipped flaky shot is left as it is, and a build with a rejected shot cannot be accepted (409). Answers the build's verdict and the ids of the builds it moved, the decided one first. ${DECISION} (POST /api/v1/builds/:id/accept-all).`,
    properties: { build_id: { type: "string", description: "A build id, from list_builds." } },
    required: ["build_id"],
    annotations: DECIDES,
    call: async ({ remote }: { remote: Remote }, args: Args): Promise<CallToolResult> =>
      text(
        (await remote.client.post(`/api/v1/builds/${id(need(args, "build_id"))}/accept-all`)).text,
      ),
  },
};
