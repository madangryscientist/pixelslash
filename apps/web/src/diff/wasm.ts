import module from "@pixelslash/engine/diff.wasm";
import { wasmDiffer } from "@pixelslash/engine/diff-wasm";
import { warn } from "#/lib/log";

/**
 * The server diff with its hot loops in WebAssembly (PS-204, a spike): `DIFF_WASM=1` picks it,
 * off by default. One differ per isolate, so its instance and memory are reused across diffs. A
 * pair that leaves the fast path still gets pngjs's answer, and the reason is logged so a flag that
 * is on but never fast shows in the logs.
 */
export const wasmDiff = wasmDiffer(module, {
  fellBack: (reason) =>
    warn(
      `diff-wasm fell back to pngjs: ${reason instanceof Error ? reason.message : String(reason)}`,
    ),
});
