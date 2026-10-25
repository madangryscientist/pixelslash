# engines/wasm: the server diff's hot loops in WebAssembly (PS-204, a spike)

A Rust crate compiled to `wasm32-unknown-unknown`. It holds the three loops that dominate the
server diff in workerd: pngjs's unfilter, the per-pixel loop (YIQ delta, anti-alias test, the
overlay paint) and the region pass's blob boxes. It was written from our TypeScript
(`packages/engine/src/diff.ts`, `yiq.ts`, `regions.ts`) and the PNG spec's filter definitions, not
from a rival's code. It must give `diffPngs`'s result byte for byte. Everything else stays in JS
(`packages/engine/src/diff-wasm.ts`): chunk parsing, inflate (workerd's zlib), the ignore mask,
merging boxes, noise, shift labels, the floors and the overlay's encode. The fast path reads 8-bit
RGB and RGBA, uninterlaced, with no critical chunk besides IHDR, IDAT and IEND and no `tRNS`.
Any other PNG (16-bit, palette, interlaced) goes to `diffPngs`, which gives the same answer.

The web app uses it only when `DIFF_WASM=1` (off by default; `apps/web/src/server/env.ts`).

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

None. There are no crates, no wasm-bindgen and no allocator crate. The module uses std only for
`f64::sqrt` and `f64::floor`, and its memory comes from a bump allocator over linear memory.

## Timing

Timing is on demand only, never in the gate:

```bash
cd apps/web && bun perf/diff-wasm/run.ts
```

The results are in `bench/PERF.md`, lever 20.
