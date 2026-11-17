import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const WEB = fileURLToPath(new URL("..", import.meta.url));
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** The suite's own state dir: the e2e's is `.wrangler/e2e`, so the two never share a D1. */
export const STATE = ".wrangler/local-build";

/** `bun <args>` from the app's directory; throws with the output on a non-zero exit. */
export function run(args: string[], env: Record<string, string> = {}) {
  const done = spawnSync("bun", args, {
    cwd: WEB,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (done.status !== 0) throw new Error(`bun ${args.join(" ")}: ${done.stdout}${done.stderr}`);
  return done.stdout;
}
