import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** One statement against the running e2e D1, as the wrangler CLI does. */
export function sql(command: string) {
  const args = ["wrangler", "d1", "execute", "DB", "--local", "--env", "e2e"];
  const result = spawnSync(
    "bunx",
    [...args, "--persist-to", ".wrangler/e2e", "--command", command],
    {
      cwd: WEB,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(`d1 failed: ${result.stderr}`);
}
