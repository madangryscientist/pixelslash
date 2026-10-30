/**
 * Build the `@hackcove/pixelslash-playwright` npm package (PS-237) into `packages/playwright`:
 * `dist/index.js`, one bundle for plain Node with the engine pieces `snapshot()` uses inlined, and
 * `dist/index.d.ts` beside it. It has no run-time dependencies: `@playwright/test` is a peer and only
 * its types are imported. `bun run build:playwright`.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const pkg = join(root, "packages/playwright");

rmSync(join(pkg, "dist"), { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(pkg, "src/index.ts")],
  outdir: join(pkg, "dist"),
  target: "node",
  external: ["playwright", "@playwright/test"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  throw new Error("bun build failed");
}

// A Bun API left in the bundle would only fail on a user's machine, under Node.
const bundle = readFileSync(join(pkg, "dist/index.js"), "utf8");
const bun = /\bBun\b|from ["']bun["']|bun:/.exec(bundle);
if (bun) throw new Error(`dist/index.js reaches for Bun (${bun[0]}): it must run under Node`);

mkdirSync(join(pkg, "dist"), { recursive: true });
copyFileSync(join(pkg, "types/index.d.ts"), join(pkg, "dist/index.d.ts"));
for (const file of ["LICENSE", "NOTICE"]) copyFileSync(join(root, file), join(pkg, file));
