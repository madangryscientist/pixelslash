import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The server diff's engine by `DIFF_WASM` (PS-207): WebAssembly by default, pngjs for any other
 * value. The Worker's bindings and the WebAssembly module are replaced, so the test reads only the
 * flag; the module itself is the wasm diff's own test (`wasm.test.ts`).
 */

const workerEnv = vi.hoisted((): Record<string, string | undefined> => ({}));
const wasmDiff = vi.hoisted(() => () => "wasm");
vi.mock("cloudflare:workers", () => ({ env: workerEnv }));
vi.mock("#/diff/wasm", () => ({ wasmDiff }));

const { inProcessDiff } = await import("./env");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The `DIFF_WASM` a wrangler.jsonc block sets in its `vars`, or undefined when it sets none. */
function diffWasmOf(block: unknown): string | undefined {
  if (!isRecord(block) || !isRecord(block.vars)) return undefined;
  const value = block.vars.DIFF_WASM;
  return typeof value === "string" ? value : undefined;
}

const wrangler: unknown = Bun.JSONC.parse(
  readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8"),
);
const e2e = isRecord(wrangler) && isRecord(wrangler.env) ? wrangler.env.e2e : undefined;

describe("the in-process diff follows DIFF_WASM (PS-207)", () => {
  beforeEach(() => {
    delete workerEnv["DIFF_WASM"];
  });

  test("the Cloudflare deploy and the e2e build both default to WebAssembly", () => {
    expect(diffWasmOf(wrangler)).toBe("1");
    expect(diffWasmOf(e2e)).toBe("1");
  });

  test("the shipped default picks the WebAssembly diff", () => {
    workerEnv["DIFF_WASM"] = diffWasmOf(wrangler);
    expect(inProcessDiff()).toBe(wasmDiff);
  });

  test("an empty value rolls back to pngjs", () => {
    workerEnv["DIFF_WASM"] = "";
    expect(inProcessDiff()).toBeUndefined();
  });

  test.each(["0", "pngjs", "true"])("any value other than 1 is pngjs: %s", (value) => {
    workerEnv["DIFF_WASM"] = value;
    expect(inProcessDiff()).toBeUndefined();
  });

  test("unset is pngjs", () => {
    expect(inProcessDiff()).toBeUndefined();
  });
});
