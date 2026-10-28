/**
 * Pack the two npm packages, built and not published (PS-237): `@hackcove/pixelslash` (the CLI) and
 * `@hackcove/pixelslash-playwright` (the Playwright helper), as `npm pack` tarballs in one directory.
 * `bun scripts/pack-npm.ts [dir]` (default `packs/`) prints the two tarball paths, one per line.
 * `examples/playwright-node` installs them; publishing is a separate, deliberate step.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dirname, "..");
const dest = resolve(process.argv[2] ?? join(root, "packs"));
mkdirSync(dest, { recursive: true });

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed`);
  return out;
}

await run(["bun", "scripts/build-cli.ts"], root);
await run(["bun", "scripts/build-playwright.ts"], root);
for (const pkg of ["packages/cli", "packages/playwright"]) {
  // `npm pack` prints the tarball's file name as the last line of stdout.
  const out = await run(["npm", "pack", join(root, pkg), "--pack-destination", dest], root);
  const filename = out.trim().split("\n").at(-1);
  if (!filename) throw new Error(`npm pack ${pkg} printed no file name`);
  console.log(join(dest, filename));
}
