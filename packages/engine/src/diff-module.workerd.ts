/**
 * `diff.wasm` in the Worker: workerd compiles a module only from an import, so the bundler turns
 * this one into a `WebAssembly.Module`. Bun resolves `#diff-module` to `diff-module.bun.ts`.
 */
import module from "../wasm/diff.wasm";

export const diffModule = (): WebAssembly.Module => module;
