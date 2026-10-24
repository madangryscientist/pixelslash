import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * ob 1876. On the CT, workerd closes the connection a moment after it answers a long finalize, and
 * the CLI's next finalize, sent at once, was dispatched on the socket miniflare's undici pool had
 * kept: `read ECONNRESET`, which the Cloudflare plugin turned into a 500 `fetch failed`. The
 * repro script stands in for workerd with a server that does that and sends through the `Pool`
 * miniflare loads, with `reset: false` as miniflare sets it. The hold is 200 ms, not 25 s: the
 * length is not what fails, the socket kept after it is.
 */
async function finalizeTwice(mode: "plain" | "fresh"): Promise<unknown> {
  const script = resolve(import.meta.dirname, "fresh-connection.repro.mjs");
  // `bun --bun vitest` puts a `node` that is Bun first on PATH; the self-host runs the real one
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => !/\/bun-node-/.test(dir))
    .join(":");
  const { stdout } = await promisify(execFile)("node", [script, mode], {
    env: { ...process.env, PATH: path },
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

describe("freshConnectionPerRequest", () => {
  it("without it, the next finalize rides the socket workerd closes and fails", async () => {
    expect(await finalizeTwice("plain")).not.toEqual([200, 200]);
  });

  it("with the plugin's preview hook, both finalizes answer their real status", async () => {
    expect(await finalizeTwice("fresh")).toEqual([200, 200]);
  });
});
