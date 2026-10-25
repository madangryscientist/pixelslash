# engines/wasm: the diff's hot loops in WebAssembly (PS-204; the only diff since PS-210)

A Rust crate compiled to `wasm32-unknown-unknown`. It holds the loops that dominate a diff: the PNG
unfilter and the expansion of every colour type and bit depth to RGBA (palette and `tRNS`, 16-bit,
Adam7), the per-pixel loop (YIQ delta, anti-alias test, the overlay paint), the region pass's blob
boxes and (PS-205) pngjs's adaptive filter for the overlay's encode, which picks each row's filter as
pngjs does and runs 16 bytes at a time in wasm SIMD. It was written from our TypeScript
(`packages/engine/src/diff.ts`, `yiq.ts`, `regions.ts`) and the PNG spec, not from a rival's code.
It gives the result the pngjs diff gave before PS-210, byte for byte, overlay included
(`packages/engine/test/fixtures/pngjs-golden.json` holds that answer for every bench corpus pair).
Everything else stays in JS (`packages/engine/src/diff-wasm.ts`): chunk parsing (pngjs's checks
and error messages), inflate (the runtime's zlib), the ignore mask, merging boxes, noise, shift
labels, the floors, and the encode's deflate (zlib at pngjs's level and strategy) and PNG chunks.

It is the one diff, in the CLI (Bun) and in the server (workerd). `#diff-module` in the engine's
`package.json` picks how the module arrives: `diff-module.bun.ts` reads `wasm/diff.wasm` from disk,
and under the `workerd` condition `diff-module.workerd.ts` imports it, so the Worker's bundle carries
it as a compiled module. There is no JS fallback: a module that will not load or instantiate fails
with an error that names `diff.wasm`.

## Building

The gate needs no Rust. The built module is committed at `packages/engine/wasm/diff.wasm`, and
beside it is `diff.wasm.json`, which holds the sha256 of every input and of the module. An engine
test (`packages/engine/test/diff-wasm.test.ts`) fails when a source changes without a rebuild.

The toolchain is pinned in `rust-toolchain.toml` (rustc 1.99.1, target `wasm32-unknown-unknown`).
After editing the crate:

```bash
mise exec rust@1.99.1 -- bun run wasm:build   # writes diff.wasm and diff.wasm.json; commit both
mise exec rust@1.99.1 -- bun run wasm:check   # rebuilds, and fails if the bytes differ from the commit
```

With rustup instead of mise, `cargo` reads `rust-toolchain.toml` itself
(`rustup target add wasm32-unknown-unknown` once).

## Dependencies

None. There are no crates, no wasm-bindgen and no allocator crate. The filter pass uses wasm SIMD
(`#[target_feature(enable = "simd128")]` on its functions, so no build flag); workerd's V8 and Bun
both run it. The module uses std only for
`f64::sqrt` and `f64::floor`, and its memory comes from a bump allocator over linear memory.

## Timing

Timing is on demand only, never in the gate. The bench times this diff, split into its phases
(`decode_inflate`, `decode_unfilter`, `decode_other`, `pixel_compare`, `regions`; `bun run
bench:perf`, see `bench/README.md`). Two harnesses time the module on its own:

- `bun run bench:native` (PS-212) times each step in wasm and in the same `lib.rs` built for the
  host (`native/`, a bench-only binary with no crates; needs `cargo`, as `wasm:build` does), and
  checks both found the same. A step slow in both is the code's; one slow only in wasm is the
  runtime's.
- `cd apps/web && bun perf/diff-wasm/run.ts` times `wasmDiff` in workerd, the server's runtime,
  after checking it gives Bun's answer (PS-204's harness, restored minimal in PS-212). For an A/B,
  run it in a checkout of each side.

The results are in `bench/PERF.md`, levers 20, 22 and 23.
