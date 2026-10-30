/**
 * `diff.wasm` under Bun and Node (the CLI, the bench, the tests), compiled once on first use. The
 * Worker's build resolves `#diff-module` to `diff-module.workerd.ts` instead (package.json
 * `imports`), since workerd compiles a module only from an import. A module that will not load
 * fails here with its path, and the diff never runs without it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATH = fileURLToPath(new URL("../wasm/diff.wasm", import.meta.url));

let compiled: WebAssembly.Module | null = null;

export function diffModule(): WebAssembly.Module {
  if (compiled) return compiled;
  try {
    compiled = new WebAssembly.Module(readFileSync(PATH));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`diff.wasm will not load from ${PATH}: ${why}`, { cause: error });
  }
  return compiled;
}
