#!/usr/bin/env bun
/**
 * `bun scripts/moon.ts <moon args>`: moon, with the root's `node_modules/.bin` on PATH. `bun run
 * <script>` puts that directory on PATH; running this file directly does not, and moon does not add
 * it either, so the tasks that call `tsc` or `oxlint` would not find them.
 */
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const env: Record<string, string | undefined> = { ...process.env };
env.PATH = `${join(root, "node_modules/.bin")}${delimiter}${env.PATH ?? ""}`;

const moon = Bun.spawnSync([process.execPath, join(root, "node_modules/.bin/moon"), ...args], {
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(moon.exitCode ?? 1);
