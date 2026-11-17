/**
 * Build the `pixelslash` npm package (PS-255) into `packages/cli`: `dist/index.js`, one bundle with
 * `@hackcove/pixelslash-engine` inlined, `dist/diff-worker.js` (the diff pool's worker), and the files beside it that the tarball ships (`wasm/diff.wasm`, which
 * the bundle reads at `../wasm/diff.wasm` from itself, and the licence). What the package depends on at
 * run time is not bundled: `playwright` is a peer, the rest are its `dependencies`. `bun run build:cli`.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = join(root, "packages/cli");

const pkgJson: {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
} = await Bun.file(join(pkg, "package.json")).json();

rmSync(join(pkg, "dist"), { recursive: true, force: true });
const result = await Bun.build({
  // The diff pool's worker is its own entry: the pool starts it from `dist/diff-worker.js`, beside
  // the bundle, and each worker reads `../wasm/diff.wasm` from itself as the bundle does.
  entrypoints: [join(pkg, "src/index.ts"), join(root, "packages/engine/src/diff-worker.ts")],
  outdir: join(pkg, "dist"),
  naming: "[name].[ext]",
  target: "bun",
  // Everything packages/cli/package.json lists as a dependency or peer stays an import (the MCP SDK
  // and Sentry are loaded on demand); `@hackcove/pixelslash-engine` is the one thing that is inlined.
  external: [...Object.keys(pkgJson.dependencies), ...Object.keys(pkgJson.peerDependencies)],
});
if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  throw new Error("bun build failed");
}

mkdirSync(join(pkg, "wasm"), { recursive: true });
copyFileSync(join(root, "packages/engine/wasm/diff.wasm"), join(pkg, "wasm/diff.wasm"));
for (const file of ["LICENSE", "NOTICE"]) copyFileSync(join(root, file), join(pkg, file));
