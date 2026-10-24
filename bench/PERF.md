# Diff speed: where we started, what we tried, where we are

The running record of the diff engine's speed work. Each perf ticket adds its run here
when it lands: the table, what moved, and which lever moved it. **Update it in the same
commit as the work**, the way `docs/capabilities/data.json` is updated. Raw samples go to the
gitignored `bench/perf-results/`. This file is the summary we keep.

How the numbers are made: `bun run bench:perf -- --impl <a> --impl <b>`, 10 interleaved rounds after
a warm-up, median ms, on Jacobus's desktop (busy, not a quiet machine). See `bench/README.md`.
Perf runs are on demand only and never in the gate.

> **Compare within a run, not across runs.** Interleaving makes A against B fair inside one run.
> Two runs on different days differ by machine load: TS long-page wall time was 1132 ms in the
> 1910 run and 986 ms in the 1932 run with the same code. Every percentage below compares rows
> from the same run.

Pages: **phone** 390×844 · **desktop** 1440×900 · **long** 1440×6000.
Engines: **ts** = `bun bench/src/impl/ts-diff.ts` (the production engine, pngjs) · **cs** =
`engines/dotnet` Release (C# port, StbImageSharp).

## Dashboard

Best known wall time per page, and the baseline it's measured against (the same run):

| Page | Baseline: ts, sequential | Best so far | Config | Change |
| --- | ---: | ---: | --- | ---: |
| phone | 180.5 ms | **81.8 ms** | cs, sequential | −55% |
| desktop | 264.3 ms | **97.5 ms** | cs, parallel decode | −63% |
| long | 986.2 ms | **223.5 ms** | cs, parallel decode | −77% |

Source: the ob 1932 run, 2026-10-24. The production engine (CLI and web) is still ts. The C#
engine is bench-only so far.

The phase-by-phase breakdown behind the [Bottlenecks](#bottlenecks) section.

Where the best long-page time goes now (cs parallel, 223.5 ms):

| Phase | ms | Share | Next lever |
| --- | ---: | ---: | --- |
| decode (wall, two files in parallel) | 92.3 | 41% | native SIMD decoder (ob 1942) |
| regions | 56.1 | 25% | not targeted yet |
| pixel_compare | 37.8 | 17% | not targeted yet (SIMD compare) |
| startup | 23.7 | 11% | AOT / ReadyToRun (not ticketed) |
| rest (spawn, JSON, exit) | 9.2 | 4% | — |
| anti_alias | 3.1 | 1% | — |

Where the production ts long-page time goes (sequential, 986.2 ms):

| Phase | ms | Share | Next lever |
| --- | ---: | ---: | --- |
| overlay_encode | 321.2 | 33% | skip in the bench, cheaper encoder (ob 1942) |
| decode | 242.1 | 25% | faster decoder: native for the CLI, WASM for workerd (ob 1942) |
| regions | 127.4 | 13% | not targeted yet |
| pixel_compare | 125.8 | 13% | not targeted yet |
| startup | 102.4 | 10% | `bun build --compile` (ob 1942) |
| rest | 39.9 | 4% | — |
| anti_alias | 21.7 | 2% | — |

## Bottlenecks

Every run is five stages. Each one is a bottleneck we name, measure and target separately:

1. **Load**: read the two PNGs and decode them to RGBA. The bench splits it into read,
   inflate (zlib), unfilter (undoing PNG's row filters) and other (allocation, colour
   conversion).
2. **Diff**: compare the pixels (pixcmp), find anti-aliasing (aa), and group changed pixels
   into regions.
3. **Encode**: write the overlay PNG. Only ts does this; the bench contract doesn't ask for it.
4. **Startup**: start the process and load the engine.
5. **Rest**: spawn, JSON out, exit.

Per stage, in ms (share of wall). The ob 1932 run, ts sequential (how production runs it),
cs in its best config: sequential on phone, parallel decode on desktop and long. Stages don't sum exactly to wall,
because each is its own median.

| Stage | ts phone | ts desktop | ts long | cs phone | cs desktop | cs long |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Load | 18.7 (10%) | 43.6 (16%) | 242.1 (25%) | **29.0 (35%)** | **36.2 (37%)** | 92.3 (41%) |
| Diff | 32.3 (18%) | 52.6 (20%) | 274.9 (28%) | 19.8 (24%) | 27.6 (28%) | **97.0 (43%)** |
| Encode | 17.2 (10%) | 53.0 (20%) | **321.2 (33%)** | – | – | – |
| Startup | **103.1 (57%)** | **104.0 (39%)** | 102.4 (10%) | 24.0 (29%) | 24.2 (25%) | 23.7 (11%) |
| Rest | 9.0 (5%) | 10.3 (4%) | 39.9 (4%) | 8.4 (10%) | 8.8 (9%) | 9.2 (4%) |
| **Wall** | 180.5 | 264.3 | 986.2 | 81.8 | 97.5 | 223.5 |

Bold is the biggest stage in each column. Where each one lies, and what is aimed at it:

| Bottleneck | Hot spot inside it | Biggest where | Lever | Ticket |
| --- | --- | --- | --- | --- |
| **Startup** | Bun loading the engine's imports (a flat ~103 ms) | ts on small pages: 57% of phone, 39% of desktop | `bun build --compile`; for cs, AOT / ReadyToRun | ob 1942 (ts); cs not ticketed |
| **Encode** | deflating the overlay PNG | ts long: 33%, the biggest ts stage | skip it where nothing reads it; a lower deflate level; sharp or WASM | ob 1942 |
| **Load** | **unfilter**: 52% of ts decode, 60% of cs decode. Inflate is 26% (ts) and 17% (cs) | cs on every page (35–41%); ts long (25%) | a SIMD native decoder (libspng, Wuffs, Skia); WASM for workerd; parallel decode on by default | ob 1942 |
| **Diff** | **regions** (ts 127 ms, cs 56 ms on long), then pixcmp (ts 126 ms, cs 38 ms). aa is small | cs long: 43%, now the biggest cs stage | a faster region pass; SIMD pixel compare | **not ticketed** |
| Rest | spawn and JSON | never above 10% | — | — |

**A pair that is byte-equal skips all five.** The identical-bytes shortcut (ob 1948) compares the
two files' bytes first: equal, and there is no decode, no diff and no overlay. The `diff-identical`
step times it on the long page (the same file twice): 665.7 ms on main, about 0.003 ms on this
tree (the in-process timed diff; the file reads are not in it). A re-run of an unchanged page,
which is most pages in most builds, costs a byte compare. It does nothing for a pair that differs
by even one byte, so it moves none of the stages above for a changed page.

So once ob 1942 lands, **Diff is the bottleneck with no ticket**: it is already the largest cs
stage on the long page, and nothing targets it yet.

## Levers: tried and queued

| # | Lever | Engine | Status | Measured effect (same run) | Ticket |
| --- | --- | --- | --- | --- | --- |
| 1 | Port the diff to C# (.NET 10, StbImageSharp) | cs | ✅ measured, bench-only | wall −27% phone, −51% desktop, −68% long against ts | ob 1910 |
| 2 | Decode base and head in parallel | ts | ✅ measured, a switch | +4% phone (Worker start-up costs more than it saves), −0.3% desktop, −11% long | ob 1932 |
| 3 | Decode base and head in parallel | cs | ✅ measured, a switch | 0% phone, −9% desktop, −22% long (285 → 224 ms) | ob 1932 |
| 4 | Phase probe overhead (the timing itself) | ts | ✅ measured | ≤1% (24.0/24.2, 80.5/80.4, 536.6/541.9 ms) | ob 1932 |
| 5 | Parallel decode on by default | cs | ⏳ queued | — | ob 1942 |
| 6 | SkiaSharp decoder (MIT) | cs | ⏳ queued | — | ob 1942 |
| 7 | libspng via P/Invoke (BSD-2), zlib and zlib-ng | cs | ⏳ queued | — | ob 1942 |
| 8 | Wuffs PNG decoder (Apache-2.0) | cs | ⏳ queued | — | ob 1942 |
| 9 | ImageSharp (paid for commercial use) | cs | ⏳ queued, measure only | — | ob 1942 |
| 10 | fast-png, upng-js | ts | ⏳ queued | — | ob 1942 |
| 11 | sharp (Apache-2.0; libvips LGPL, dynamic), @napi-rs/image | ts (CLI only) | ⏳ queued | — | ob 1942 |
| 12 | WASM decoders (@jsquash/png; libspng or Wuffs in WASM) | ts (workerd-safe) | ⏳ queued | — | ob 1942 |
| 13 | Overlay encode: lower deflate level, sharp, WASM, skip | ts | ⏳ queued | — | ob 1942 |
| 14 | `bun build --compile` for startup | ts | ⏳ queued | — | ob 1942 |
| 15 | Faster regions / SIMD pixel compare | both | 💡 not ticketed | — | — |
| 16 | .NET Native AOT / ReadyToRun for startup | cs | 💡 not ticketed | — | — |
| 17 | Identical-bytes shortcut: skip decode, diff and overlay when both PNGs are byte-equal (server: sha256 at upload, so no blob read either) | ts + web | ✅ measured | long page, same file twice: 665.7 ms → 0.003 ms (in-process diff); changed pages 0% (desktop −2.3%, long +0.1%, noise) | ob 1948 |

Upper bounds (estimates, not measured; one phase's whole share removed):
- ts long without the overlay encode: about 986 − 321 = 665 ms (−33%).
- cs long with decode halved: about 223 − 46 = 177 ms (−21%).

## What we know

- **Both engines' decode is limited by unfiltering, not inflating.** Unfilter is 50–60% of
  decode. Swapping only the inflate stage (for example zlib-ng) caps out at about 25–30% of
  decode in C#.
- **ts loses in the diff, not the decode.** Its biggest phase is encoding an overlay PNG the
  bench contract never asks for.
- **ts startup is a flat ~103 ms.** The engine imports are inside it. cs starts in ~24 ms.
- **Parallel decode only pays on big images.** On phone, the Worker's start-up costs more than
  it takes off the main thread.
- **cs anti-alias is nearly free** (0.3–3.1 ms, against ts's 5–22 ms).
- **Accuracy is unchanged.** cs matches ts row for row on both corpora (157 pairs: same
  verdicts, same regions). Every speed change must keep that, and ob 1942 adds a
  byte-identical decode test for every decoder candidate.
- **Constraint:** the web app's server diff runs in workerd, which can load WASM but no native
  code. The CLI (Bun) can load native code. So the fastest production ts option may differ per
  path.

## Run log

Newest first. One entry per perf run that landed.

### 2026-10-24 · ob 1948 · identical-bytes shortcut

`bun run bench:perf -- --only diff-desktop,diff-long,diff-identical`: main (481e6e9) against this tree,
10 interleaved rounds, one run. The step is new; main runs the bench's measuring code on its own
engine, so it decodes and diffs the identical pair in full.

| Step | main median | this tree median | change | main p95 | this tree p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| diff + regions, desktop 1440x900 | 105.3 | 102.8 | −2.3% | 110.4 | 111.7 |
| diff + regions, long page 1440x6000 | 714.5 | 715.2 | +0.1% | 802.3 | 758.8 |
| identical pair, long page 1440x6000, same file twice | 665.7 | 0.003 | −100% | 2133.8 | 0.004 |

The two changed pages did not move: the byte compare of two different files stops at the first
differing byte. The identical row times the diff in-process, so it leaves out reading the two
files and the process start. On the server the same pair is not even read: equal sha256 values
(stored at upload) settle it with no blob read.

### 2026-10-24 · ob 1932 · per-phase timings, parallel decode

`--decode sequential`, median ms:

| Page | Engine | decode | read | inflate | unfilter | other | pixcmp | aa | regions | overlay | startup | rest | wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| phone | ts | 18.7 | 0.0 | 2.3 | 9.3 | 6.8 | 7.8 | 5.9 | 18.6 | 17.2 | 103.1 | 9.0 | 180.5 |
| phone | cs | 29.0 | 2.3 | 5.4 | 9.1 | 11.2 | 7.6 | 0.3 | 11.9 | – | 24.0 | 8.4 | 81.8 |
| desktop | ts | 43.6 | 0.0 | 9.5 | 21.0 | 13.0 | 20.4 | 5.1 | 27.1 | 53.0 | 104.0 | 10.3 | 264.3 |
| desktop | cs | 45.2 | 2.3 | 8.3 | 20.5 | 13.3 | 11.0 | 0.3 | 16.0 | – | 23.8 | 9.2 | 107.1 |
| long | ts | 242.1 | 0.1 | 62.9 | 125.8 | 50.1 | 125.8 | 21.7 | 127.4 | 321.2 | 102.4 | 39.9 | 986.2 |
| long | cs | 153.2 | 2.3 | 26.6 | 92.7 | 30.1 | 38.5 | 3.1 | 56.9 | – | 23.6 | 9.4 | 285.2 |

`--decode parallel` (decode is the wall time; the split is the summed work over both files):

| Page | Engine | decode | read | inflate | unfilter | other | pixcmp | aa | regions | overlay | startup | rest | wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| phone | ts | 22.3 | 0.0 | 2.4 | 10.6 | 8.0 | 9.4 | 8.4 | 20.1 | 17.7 | 103.9 | 9.0 | 188.5 |
| phone | cs | 27.1 | 3.1 | 10.1 | 11.3 | 21.7 | 8.6 | 0.3 | 12.1 | – | 24.1 | 8.3 | 81.9 |
| desktop | ts | 37.6 | 0.0 | 9.9 | 27.3 | 13.8 | 21.1 | 8.6 | 28.6 | 53.3 | 104.0 | 10.8 | 263.5 |
| desktop | cs | 36.2 | 3.2 | 13.5 | 21.5 | 24.1 | 11.3 | 0.3 | 16.0 | – | 24.2 | 8.8 | 97.5 |
| long | ts | 137.6 | 0.1 | 69.0 | 133.6 | 43.9 | 129.1 | 21.8 | 125.7 | 321.2 | 101.9 | 27.3 | 874.7 |
| long | cs | 92.3 | 3.2 | 32.6 | 93.6 | 41.5 | 37.8 | 3.1 | 56.1 | – | 23.7 | 9.2 | 223.5 |

### 2026-10-24 · ob 1910 · the C# engine against ts

Median ms. "self" is decode + diff as the engine reports it, and "change" is cs wall against ts wall.

| Page | Engine | decode | diff | self | wall | p95 (self) | change |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| phone | ts | 18.2 | 44.0 | 62.1 | 190.2 | 66.6 | |
| phone | cs | 20.7 | 24.5 | 45.1 | 74.4 | 49.6 | −27.4% |
| desktop | ts | 42.0 | 93.9 | 136.7 | 292.0 | 147.2 | |
| desktop | cs | 37.1 | 29.8 | 66.8 | 97.6 | 70.7 | −51.1% |
| long | ts | 236.6 | 519.0 | 757.1 | 1132.0 | 768.9 | |
| long | cs | 143.5 | 101.8 | 243.0 | 273.3 | 254.9 | −67.9% |

The ts diff includes encoding the overlay PNG.

### Tooling history

- ob 1790: `bench:perf`, this tree against a base, interleaved, with a check that fails on more than 25% slower.
- ob 1909: the language-neutral diff contract, and `--impl` for timing engines against each other.
- ob 1910: the C# engine behind the contract.
- ob 1932: per-phase timings, `startup_ms`, `--decode parallel|sequential`.
