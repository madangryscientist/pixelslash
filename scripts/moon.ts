#!/usr/bin/env bun
/**
 * `bun scripts/moon.ts <moon args>`: moon, with the .NET SDK found for it and the `dotnet`-tagged
 * project (`engines/dotnet`) left out when there is none. The SDK is optional for contributors: one
 * who only touches the TS projects must still be able to run the gate, so with no working `dotnet` a
 * `moon run` is limited to the projects not tagged `dotnet` (`--query "tag!=dotnet"`). The skip is
 * printed, not silent. `PIXELSLASH_DOTNET_DISABLE` set to any value skips the search and the line,
 * and leaves the project out.
 *
 * Which `dotnet` a task runs is decided here, not left to PATH: moon puts only its own bin dirs ahead
 * of the caller's PATH, so the first `dotnet` on it wins, and that can be a host with no SDK (say
 * `/usr/bin/dotnet`) ahead of a working one (mise's). The directory of the first that works goes
 * first on PATH.
 */
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The first `dotnet` on PATH that runs (from the root, so `global.json` applies), or null. Each is
 * tried: one that exists can still fail (a host with no SDK, a mise shim where none is active).
 */
function findDotnet(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "dotnet");
    if (dir === "" || !existsSync(candidate)) continue;
    try {
      const ran = Bun.spawnSync([candidate, "--version"], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      if (ran.success) return candidate;
    } catch {
      // Not runnable; try the next one.
    }
  }
  return null;
}

const args = process.argv.slice(2);
const env: Record<string, string | undefined> = { ...process.env };
// `bun run <script>` puts the root's node_modules/.bin on PATH; running this file directly does not,
// and moon does not add it either, so the tasks that call `tsc` or `oxlint` would not find them.
env.PATH = `${join(root, "node_modules/.bin")}${delimiter}${env.PATH ?? ""}`;

const disabled = env.PIXELSLASH_DOTNET_DISABLE !== undefined;
const dotnet = disabled ? null : findDotnet();
if (dotnet !== null) {
  env.PATH = `${dirname(dotnet)}${delimiter}${env.PATH}`;
} else {
  if (!disabled) console.log("dotnet SDK not found: skipping engines/dotnet");
  if (args[0] === "run") {
    // Before any `--`, which hands the rest to the task itself.
    const passthrough = args.indexOf("--");
    args.splice(passthrough === -1 ? args.length : passthrough, 0, "--query", "tag!=dotnet");
  }
}

const moon = Bun.spawnSync([process.execPath, join(root, "node_modules/.bin/moon"), ...args], {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(moon.exitCode ?? 1);
