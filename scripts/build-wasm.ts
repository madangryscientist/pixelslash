/**
 * Build the diff's WebAssembly (PS-204) from `engines/wasm` and commit what it writes: the module
 * at `packages/engine/wasm/diff.wasm` and, beside it, `diff.wasm.json`, the sha256 of every input
 * and of the module. The gate never runs this (it needs Rust): an engine test reads the manifest
 * and fails when a source or the module no longer matches it, so the Rust cannot change without a
 * rebuild. `--check` rebuilds and fails when the result differs from the committed module.
 *
 * The toolchain is pinned in `engines/wasm/rust-toolchain.toml`; with rustup or mise's Rust, `cargo`
 * picks it up there (`rustup target add wasm32-unknown-unknown` once).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const crate = join(root, "engines/wasm");
const built = join(crate, "target/wasm32-unknown-unknown/release/pixelslash_diff_wasm.wasm");
const out = join(root, "packages/engine/wasm/diff.wasm");

/** Everything the module is built from, relative to the repo root. */
const WASM_SOURCES = [
  "engines/wasm/Cargo.toml",
  "engines/wasm/Cargo.lock",
  "engines/wasm/rust-toolchain.toml",
  "engines/wasm/src/lib.rs",
];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function build(): Uint8Array {
  const cargo = Bun.spawnSync(
    ["cargo", "build", "--release", "--locked", "--target", "wasm32-unknown-unknown"],
    { cwd: crate, stdout: "inherit", stderr: "inherit" },
  );
  if (cargo.exitCode !== 0) throw new Error(`cargo build exited ${cargo.exitCode}`);
  return readFileSync(built);
}

const wasm = build();
if (process.argv.includes("--check")) {
  if (sha256(wasm) !== sha256(readFileSync(out))) {
    console.error(`${out} is not what engines/wasm builds: run bun scripts/build-wasm.ts`);
    process.exit(1);
  }
  console.log(`diff.wasm matches its source (${wasm.length} bytes)`);
} else {
  writeFileSync(out, wasm);
  const sources = Object.fromEntries(
    WASM_SOURCES.map((path) => [path, sha256(readFileSync(join(root, path)))]),
  );
  const manifest = { sources, wasm: sha256(wasm), bytes: wasm.length };
  writeFileSync(`${out}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out} (${wasm.length} bytes)`);
}
