# Diff speed: where we started, what we tried, where we are

The running record of the diff engine's speed work. Each perf ticket adds its run here
when it lands: the table, what moved, and which lever moved it. **Update it in the same
commit as the work**, the way `docs/capabilities/data.json` is updated. Raw samples go to the
gitignored `bench/perf-results/`. This file is the summary we keep.

How the numbers are made: `bun run bench:perf -- --impl <a> --impl <b>`, 10 interleaved rounds after
a warm-up, median ms, on Jacobus's desktop (busy, not a quiet machine). See `bench/README.md`.
Perf runs are on demand only and never in the gate.

> **Compare within a run and an env, not across.** Every run records its `env` (ob 1947): `shared` is
> the desktop as it was, with the browser and the editor running; `dedicated` is `--env dedicated`,
> with whole cores and memory reserved and boost off. Only rows from the same run and the same env
> are compared; a `dedicated` number is not "faster" than a `shared` one, it is steadier.
>
> **Compare within a run, not across runs.** Interleaving makes A against B fair inside one run.
> Two runs on different days differ by machine load: TS long-page wall time was 1132 ms in the
> 1910 run and 986 ms in the 1932 run with the same code. Every percentage below compares rows
> from the same run.

Pages: **phone** 390×844 · **desktop** 1440×900 · **long** 1440×6000.
Engines: **ts** = `bun bench/src/impl/ts-diff.ts`, the production engine's `diffRasters`; since PS-168 it
decodes with napi-image and encodes no overlay by default, so the production-shaped run is
`--decoder pngjs --overlay pngjs`. It imports `@pixelslash/engine/diff`, not the package root the CLI
loads, so it leaves out the CLI's Playwright import (about 80 ms of start-up) · **cs** = `engines/dotnet` Release (C# port; SkiaSharp decode, in
parallel, by default since PS-168; StbImageSharp before).

## Dashboard

Best known wall time per page, against ts doing the same work (the same run, `env` dedicated). Every
column decodes, diffs and finds regions, and none encodes an overlay PNG, because cs has no overlay.
The production-shaped ts also encodes the overlay, which cs does not do, so it is shown for scale but
is not a baseline:

| Page | ts, production-shaped (+ overlay) | ts, pngjs, no overlay | ts, napi-image, no overlay | Best so far | Config | vs pngjs | vs napi-image | Shipped cs default (skia, parallel) | vs pngjs | vs napi-image |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| phone | 128.1 ms | 105.5 ms | 88.0 ms | **87.1 ms** | cs, libspng on zlib-ng, parallel | −17% | −1% | 95.3 ms | −10% | +8% |
| desktop | 247.4 ms | 163.3 ms | 122.2 ms | **95.1 ms** | cs, libspng on zlib-ng, parallel | −42% | −22% | 105.7 ms | −35% | −14% |
| long | 1114.8 ms | 706.4 ms | 438.6 ms | **195.0 ms** | cs, libspng on zlib-ng, parallel | −72% | −56% | 207.2 ms | −71% | −53% |

**Work done.** cs does less than the production engine: it has no overlay image and no ignore areas
(`engines/dotnet/PixelSlash.Diff/Diff.cs`, "not ported"). Its numbers compare only against a ts row
with `--overlay none`. Before 2026-10-25 this table measured "Change" against the production-shaped
row (−32% / −62% / −83% best, −26% / −57% / −81% shipped), which credited cs for skipping the overlay
encode.

Source: the PS-168 run, 2026-10-25, `--env dedicated`. It is not comparable with the ob 1932
dashboard (`shared`, boost on), which it replaces. The production engine (CLI and web) is still ts
with pngjs. The C# engine is bench-only so far. libspng on zlib-ng is the fastest, but it needs
`native/build.sh`; the shipped cs default is SkiaSharp, from NuGet (see the PS-168 entry).

The phase-by-phase breakdown behind the [Bottlenecks](#bottlenecks) section.

Where the shipped cs long-page time goes (skia parallel, 207.2 ms):

| Phase | ms | Share | Next lever |
| --- | ---: | ---: | --- |
| regions | 76.4 | 37% | not ticketed (lever 15) |
| pixel_compare | 48.1 | 23% | not ticketed (SIMD compare, lever 15) |
| decode (wall, two files in parallel) | 32.7 | 16% | libspng on zlib-ng: 16.9 ms, needs a native build |
| rest (spawn, JSON, exit) | 27.6 | 13% | — |
| startup | 16.0 | 8% | AOT / ReadyToRun (lever 16) |
| anti_alias | 4.2 | 2% | — |

Where the production-shaped ts long-page time goes (pngjs, sequential, pngjs overlay, 1114.8 ms):

| Phase | ms | Share | Next lever |
| --- | ---: | ---: | --- |
| overlay_encode | 415.8 | 37% | napi-image encode: 27.3 ms (CLI only); not changed in production |
| decode | 274.7 | 25% | napi-image: 29.8 ms (CLI only); not changed in production |
| pixel_compare | 171.8 | 15% | not ticketed (lever 15) |
| regions | 158.6 | 14% | not ticketed (lever 15) |
| anti_alias | 31.9 | 3% | — |
| rest | 29.6 | 3% | — |
| startup | 21.1 | 2% | — (was ~103 ms; see "What we know") |

## Bottlenecks

Every run is five stages. Each one is a bottleneck we name, measure and target separately:

1. **Load**: read the two PNGs and decode them to RGBA. The bench splits it into read,
   inflate (zlib), unfilter (undoing PNG's row filters) and other (allocation, colour
   conversion). Only pngjs and stb split it; every other decoder is one `other` span.
2. **Diff**: compare the pixels (pixcmp), find anti-aliasing (aa), and group changed pixels
   into regions.
3. **Encode**: write the overlay PNG. Only ts does this; the bench contract doesn't ask for it.
4. **Startup**: start the process and load the engine.
5. **Rest**: spawn, JSON out, exit.

Per stage, in ms (share of wall). The PS-168 run, `env` dedicated: ts production-shaped (pngjs,
sequential, pngjs overlay), cs in its shipped default (skia, parallel). Stages don't sum exactly to
wall, because each is its own median.

| Stage | ts phone | ts desktop | ts long | cs phone | cs desktop | cs long |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Load | 25.7 (20%) | 52.4 (21%) | 274.7 (25%) | 19.3 (20%) | 20.9 (20%) | 32.7 (16%) |
| Diff | **51.4 (40%)** | **81.4 (33%)** | 362.3 (32%) | **31.4 (33%)** | **40.0 (38%)** | **128.7 (62%)** |
| Encode | 23.4 (18%) | 80.8 (33%) | **415.8 (37%)** | – | – | – |
| Startup | 21.1 (16%) | 21.1 (9%) | 21.1 (2%) | 16.4 (17%) | 16.3 (15%) | 16.0 (8%) |
| Rest | 6.2 (5%) | 9.1 (4%) | 29.6 (3%) | 26.7 (28%) | 26.9 (25%) | 27.6 (13%) |
| **Wall** | 128.1 | 247.4 | 1114.8 | 95.3 | 105.7 | 207.2 |

Bold is the biggest stage in each column. Where each one lies, and what is aimed at it:

| Bottleneck | Hot spot inside it | Biggest where | Lever | Ticket |
| --- | --- | --- | --- | --- |
| **Diff** | **regions** (ts 159 ms, cs 76 ms on long), then pixcmp (ts 172 ms, cs 48 ms). aa is small | every cs page, and ts phone and desktop | a faster region pass; SIMD pixel compare | **not ticketed** |
| **Encode** | deflating the overlay PNG; the deflate level does not move it | ts long: 37% | napi-image encodes it in 27 ms (CLI only) | measured in PS-168; production unchanged |
| **Load** | unfilter, for pngjs and stb (56% and 65% of decode) | ts long: 25% | measured in PS-168: SkiaSharp is the cs default; napi-image is the ts bench default | done for the bench; the CLI ships napi-image (PS-185), workerd stays on pngjs |
| Startup | Bun loading the engine's imports | ts phone: 16% | `bun build --compile` measured: no gain | done (PS-168) |
| Rest | spawn, JSON, exit; cs's grew to ~27 ms with SkiaSharp (stb ~20 ms in the same run) | cs phone: 28% | not targeted | — |

**A pair that is byte-equal skips all five.** The identical-bytes shortcut (ob 1948) compares the
two files' bytes first: equal, and there is no decode, no diff and no overlay. The `diff-identical`
step times it on the long page (the same file twice): 665.7 ms on main, about 0.003 ms on this
tree (the in-process timed diff; the file reads are not in it). A re-run of an unchanged page,
which is most pages in most builds, costs a byte compare. It does nothing for a pair that differs
by even one byte, so it moves none of the stages above for a changed page.

So after PS-168, **Diff is the bottleneck, and it has no ticket**: it is the largest cs stage on
every page (62% of the long page) and the largest ts stage on phone and desktop.

## Levers: tried and queued

Rows 5–14 are the PS-168 run (2026-10-25, `env` dedicated), long page, `self` median (decode +
diff) unless it says wall. The full table is `bench/results/decoders-2026-10.md`.

| # | Lever | Engine | Status | Measured effect (same run) | Ticket |
| --- | --- | --- | --- | --- | --- |
| 1 | Port the diff to C# (.NET 10, StbImageSharp) | cs | ✅ measured, bench-only | wall −27% phone, −51% desktop, −68% long against ts, but ts encoded the overlay and cs did not. On equal work (PS-168, shipped cs, no overlay): −10% / −35% / −71% against pngjs, +8% / −14% / −53% against napi-image | ob 1910 |
| 2 | Decode base and head in parallel | ts | ✅ measured, a switch | +4% phone (Worker start-up costs more than it saves), −0.3% desktop, −11% long | ob 1932 |
| 3 | Decode base and head in parallel | cs | ✅ measured, a switch | 0% phone, −9% desktop, −22% long (285 → 224 ms) | ob 1932 |
| 4 | Phase probe overhead (the timing itself) | ts | ✅ measured | ≤1% (24.0/24.2, 80.5/80.4, 536.6/541.9 ms) | ob 1932 |
| 5 | Parallel decode on by default | cs | ✅ measured, shipped | stb: 318.7 → 253.1 ms (−21%) | PS-168 |
| 6 | SkiaSharp decoder (MIT) | cs | ✅ measured, shipped as the default | 163.7 ms (−49% against stb sequential); decode 32.7 ms | PS-168 |
| 7 | libspng via P/Invoke (BSD-2), zlib and zlib-ng | cs | ✅ measured, a switch (needs `native/build.sh`) | zlib 215.1 ms (−33%); zlib-ng 147.6 ms (−54%), the fastest; decode 16.9 ms | PS-168 |
| 8 | Wuffs PNG decoder (Apache-2.0) | cs | ✅ measured, a switch (needs `native/build.sh`) | 156.6 ms (−51%) | PS-168 |
| 9 | ImageSharp (paid for commercial use) | cs | ✅ measured, never shipped | 271.2 ms (−15%), slower than every permissive native decoder | PS-168 |
| 10 | fast-png, upng-js | ts | ✅ measured, a switch | slower than pngjs: fast-png +81%, upng +21% (sequential) | PS-168 |
| 11 | sharp (Apache-2.0; libvips LGPL, dynamic), @napi-rs/image | ts (CLI only) | ✅ measured; napi-image is the bench default | napi-image 402.6 ms (−39% against pngjs sequential, decode 29.8 ms); sharp 465.7 ms (−29%), LGPL, never shipped | PS-168 |
| 12 | WASM decoders (@jsquash/png; libspng or Wuffs in WASM) | ts (workerd-safe) | ✅ measured, a switch | jsquash parallel 528.9 ms, tied with pngjs parallel (523.8); @cf-wasm/png +442%; libspng and Wuffs in WASM could not build | PS-168 |
| 13 | Overlay encode: lower deflate level, sharp, WASM, skip | ts | ✅ measured; `none` is the bench default | long `overlay_encode`: pngjs 415.8, level 6 414.6, level 1 404.1, cf-wasm 231.2, sharp 35.3, napi-image 27.3 ms; wall 1114.8 → 706.4 ms with none | PS-168 |
| 14 | `bun build --compile` for startup | ts | ✅ measured, not adopted | startup 21.2 → 26.4 ms (slower); self −2% | PS-168 |
| 15 | Faster regions / SIMD pixel compare | both | 💡 not ticketed | — | — |
| 16 | .NET Native AOT / ReadyToRun for startup | cs | 💡 not ticketed | — | — |
| 17 | Identical-bytes shortcut: skip decode, diff and overlay when both PNGs are byte-equal (server: sha256 at upload, so no blob read either) | ts + web | ✅ measured | long page, same file twice: 665.7 ms → 0.003 ms (in-process diff); changed pages 0% (desktop −2.3%, long +0.1%, noise) | ob 1948 |
| 19 | Self-host server diff in a Bun sidecar with napi-image (workerd keeps pngjs on Cloudflare) | web (self-host) | ✅ measured, shipped | PS-200 burst, 50 shots 1280×5000: diff time 29.7/37.9 → 11.9/14.3 s; workerd settled RSS 660/691 → 357/363 MB | PS-203 |
| 18 | Shoot pages at once: a pair's two, up to four in `capture` and `check` (each its own context and settle; the waits overlap, none is shortened) | CLI capture | ✅ measured, shipped | capture-only 10 shots total 6630 → 2527 ms (−62%); long pair 2162 → 1559 ms (−28%); 5-route pair 7.4 → 4.5 s (−39%); PNGs byte-equal | PS-195 |
| 20 | Server diff's hot loops (unfilter, pixel loop, region blobs) in Rust→WASM; inflate and the overlay encode unchanged | web (workerd) | ✅ measured, on (`DIFF_WASM`, on by default since PS-207) | workerd, 15 rounds: phone 42.4 → 22.6 ms (−47%), desktop 126.3 → 75.7 (−40%), long 891.8 → 531.7 (−40%); peak RSS after the rounds 2140 → 347 MB; byte-equal | PS-204 |
| 21 | Free the explain queue's full-page decodes: `regionCrops` decodes one PNG at a time and releases its raster, `explainShot` releases the three blobs it read | web + engine | ✅ measured, shipped | burst 50 × 1280×9500 with the model on: workerd peak 1497 → 783 / 728 MB, settled 1499 → 611 / 617 MB; crops unchanged | PS-206 |

Upper bounds (estimates, not measured; one phase's whole share removed):
- cs long with regions free: about 207 − 76 = 131 ms (−37%).
- cs long with pixel_compare free: about 207 − 48 = 159 ms (−23%).

## What we know

- **Diff is now the biggest stage for both engines.** Regions plus pixel_compare are 124 ms of
  cs's 207 ms long page, and 330 ms of ts's 1115 ms. No decoder change moves them.
- **A SIMD native decoder takes cs decode from 189.5 ms (stb, sequential) to 16.9–32.7 ms** on the
  long page (libspng on zlib-ng, Wuffs, SkiaSharp, all parallel). Unfilter was the part stb was slow at.
- **ts's fastest decoder is native** (napi-image, CLI only). Among what workerd can load (WASM or
  JS), nothing beats pngjs: pngjs parallel 523.8 ms and jsquash parallel 528.9 ms are a tie.
- **The overlay's deflate level does not matter** (404–416 ms at every pngjs level); the encoder does
  (napi-image 27 ms, sharp 35 ms).
- **ts startup is now ~21 ms**, against ~103 ms in the ob 1932 run. The bench imports
  `@pixelslash/engine/diff` instead of the package root, which loaded Playwright. That is two runs
  in two envs, so it is not a percentage. `bun build --compile` does not improve it (26 ms).
- **Parallel decode only pays on big images, and only for a slow decoder.** On phone the Worker's
  start-up costs more than it saves; with napi-image, parallel is slower even on the long page
  (449.2 against 402.6 ms).
- **cs anti-alias is nearly free** (0.4–4.2 ms, against ts's 8–32 ms).
- **Accuracy is unchanged.** cs matches ts row for row on both corpora (157 pairs: same verdicts,
  same regions), with SkiaSharp parallel as with stb sequential. Every TS decoder candidate gives
  pngjs's RGBA byte for byte on every corpus PNG (`bench/test/codecs.test.ts`).
- **In workerd, the hot loops in WASM take 40–47% off the diff** (PS-204), and the long page drops
  from 892 to 532 ms. The overlay encode (pngjs, about 330 ms on the long page) is then 62% of what
  is left, so it is the next lever there. Without the encode, the long page is about 560 ms against
  about 200 ms. The module is 26 KB.
- **Constraint:** the web app's server diff runs in workerd, which can load WASM but no native
  code. The CLI (Bun) can load native code. So the fastest production ts option differs per path:
  napi-image for the CLI, pngjs (or jsquash) for workerd. Since PS-203 the self-host's Worker sends
  the diff to a Bun sidecar with napi-image; the Cloudflare deploy diffs in workerd with PS-204's
  WASM (`DIFF_WASM`, on by default since PS-207), and pngjs when the flag is set to anything else.

## Run log

Newest first. One entry per perf run that landed. The `env` column says what the machine was doing
(see the note at the top): the runs before ob 1947 are all `desktop, shared`.

| Run | Ticket | env | What |
| --- | --- | --- | --- |
| 2026-10-25 | PS-206 | desktop, shared | workerd's memory on an HC-124-sized burst, with the explain queue on |
| 2026-10-25 | planner | desktop, dedicated | ts with the overlay encode on and off, pngjs and napi-image, against cs |
| 2026-10-25 | PS-204 | desktop, shared | the server diff's hot loops in Rust→WASM, timed in workerd |
| 2026-10-25 | PS-203 | desktop, shared | the self-host's server diff in a Bun sidecar with napi-image |
| 2026-10-25 | PS-195 | desktop, shared | capture split into navigate, settle, screenshot and launch; pages shot at once |
| 2026-10-25 | PS-190 | desktop, shared | where a real run's time goes: capture vs diff, CLI and server (measurement, no code) |
| 2026-10-25 | PS-168 | desktop, dedicated | decoders and encoders: every candidate for both engines |
| 2026-10-24 | ob 1947 | desktop, dedicated | `--env dedicated` against `--env none`: spread of p95 over median |
| 2026-10-24 | ob 1948 | desktop, shared | identical-bytes shortcut |
| 2026-10-24 | ob 1932 | desktop, shared | per-phase timings, parallel decode |
| 2026-10-24 | ob 1910 | desktop, shared | the C# engine against ts |

### 2026-10-25 · PS-206 · desktop, shared · workerd's memory on a burst that is explained

**The 1.5 GB was the explain queue, not the diff, and it is now about 0.6–0.8 GB.** With the
project's model set, every changed shot is explained after the finalise. `explainShot` read the
baseline, the branch and the overlay whole, and `regionCrops` decoded all three with pngjs at once
(about 49 MB of raster each at 1280×9500). None of it was freed, and a Worker has no `gc()`. On an
HC-124-sized burst, workerd went from 382 MB to 1497 MB and stayed there. The diff alone, with the
sidecar, never passed 454 MB. Now `regionCrops` decodes one image at a time and releases its raster
before the next one (`release()`, as in PS-200), and `explainShot` releases the three blobs once
they are cut. The crops are the same (`packages/engine/test/region-crops.test.ts`).

**Env.** Linux desktop, 12 cores, load average about 7 (other worktrees running), browser and editor
up (`shared`). The burst is `apps/web/e2e/rss-burst.spec.ts` against the e2e production build, with
the diff sidecar on as the LAN runs it. It sends 50 shots of 1280×9500, the HC-124 size, to main,
then 50 changed ones to a branch, finalises the branch, and with `PIXELSLASH_RSS_MODEL=1` waits until
the e2e stub's model has explained every shot. All the RSS figures are workerd's except where a
column says otherwise. The spec now also samples `vite preview`, which shares workerd's cgroup on
the LAN box, and it GETs `/` once a second throughout. The spec fails if a probe fails or takes
longer than 10 s.

```bash
cd apps/web
PIXELSLASH_RSS_BURST=50 PIXELSLASH_RSS_HEIGHT=9500 bunx playwright test rss-burst                       # diff only
PIXELSLASH_RSS_MODEL=1 PIXELSLASH_RSS_BURST=50 PIXELSLASH_RSS_HEIGHT=9500 bunx playwright test rss-burst  # with explain
```

| Run | after main | peak | settled 10 s | sidecar peak | vite peak | diff | explain | GET / probes (failed, slowest) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| before, diff only | 446 MB | 454 MB | 349 MB | 482 MB | 503 MB | 21.9 s | — | 33 (0, 118 ms) |
| before, explained | 382 MB | **1497 MB** | **1499 MB** | 466 MB | 554 MB | 21.8 s | 31.4 s | 64 (0, 1323 ms) |
| after, explained #1 | 385 MB | **783 MB** | **611 MB** | 466 MB | 555 MB | 24.5 s | 37.2 s | 73 (0, 1078 ms) |
| after, explained #2 | 307 MB | **728 MB** | **617 MB** | 457 MB | 571 MB | 24.8 s | 42.9 s | 92 (0, 1458 ms) |

The diff and explain times moved with the load: the change frees memory and adds no work. The
explain stub answers at once, so the explain column is the queue and the crops, not a model's time.

**Against the CT's cap.** `pixelslash-web` runs vite preview and workerd in one cgroup, with
MemoryHigh at 1400M. Before the change, workerd alone reached 1.5 GB, which matches the live stall.
After it, workerd peaks at 0.73–0.78 GB. The sum of the two processes' separate peaks is about
1.3 GB, but they do not peak at the same moment. The rest of workerd's settled ~610 MB is the
isolate's heap and allocator after 100 uploads (about 180 MB of it at idle). This change does not
touch it.

**Not changed.** Diff semantics, the sidecar, `DIFF_WASM` and the Cloudflare path: the only
difference on Cloudflare is that the explain queue's buffers are freed. There is no admission limit
on the upload or the diff. Freeing removed the cause, and workerd cannot read its own RSS to refuse
on it. The burst shows `/` answering throughout.

**Not measured.** The CT itself (2 vCPU, PS-155's caps): the planner said not to touch it. Whether
workerd and vite peak together there is not measured either. A real
model's latency is not measured either: the stub answers at once. A slow model keeps fewer crops
in flight per shot, not more rasters, because the rasters are freed before the call.
### 2026-10-25 · planner · desktop, dedicated · the overlay encode on and off, against cs

Asked for by Jacobus, so it ran on demand, not as part of a ticket. Five implementations of `bench:perf --env dedicated --runs
10`, interleaved: ts with pngjs and napi-image, each with the overlay encode on (`--overlay pngjs`,
`--overlay napi-image`) and off (`--overlay none`), and cs (SkiaSharp, parallel, the shipped default).
cs encodes no overlay, so only the `none` rows are equal work for it. The host was busy (load 5 to 8,
with a builder's gate running), but the reserved cores saw no other tasks. Raw:
`bench/perf-results/2026-10-25T16-37-09-610Z.json`.

Wall, median ms:

| Page | ts pngjs + overlay | ts pngjs, none | ts napi-image + overlay | ts napi-image, none | cs | cs vs pngjs, none | cs vs napi-image, none |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| phone | 138.7 | 112.2 | 99.5 | 97.4 | 103.1 | −8% | +6% |
| desktop | 252.5 | 174.9 | 140.4 | 136.3 | 115.9 | −34% | −15% |
| long | 1139.0 | 721.0 | 564.2 | 517.9 | 243.1 | −66% | −53% |

The overlay encode's own phase (median ms):

| Page | pngjs | napi-image |
| --- | ---: | ---: |
| phone | 24.2 | 2.5 |
| desktop | 78.3 | 6.1 |
| long | 412.9 | 48.1 |

- **On equal work, cs's gain is about half of what the old tables said.** On the long page it is −53%
  against the fastest ts, with no overlay on either side. cs is slower than ts on phone (+6%), because
  its start-up and rest (54 ms) cost more than its faster diff saves on a small page. On self
  (decode + diff, no process) cs is −26% / −41% / −61% against napi-image.
- **The pngjs overlay encode was 37% of the production-shaped long page** (413 of 1139 ms). With
  napi-image it is 48 ms. That one stage is most of the gap the old "Change" columns credited to cs.
- **The earlier 3-engine run** (08:15, same env, `bench/perf-results/2026-10-25T08-15-53-847Z.json`):
  ts pngjs + pngjs overlay, ts napi-image + napi-image overlay and cs, at 1118.5 / 465.6 / 205.0 ms wall on the
  long page. Its "vs #1" (cs −56% / −74% / −86%, as self) compared cs against ts doing the overlay
  encode, so it has the same flaw as the pre-fix dashboard. This run replaces it.
- **Napi-image's decode was 3x slower here than in PS-168** (86.5 against 29.8 ms on long). kswapd
  and btrfs writeback were on the host. Compare these rows with each other, not with PS-168's.

### 2026-10-25 · PS-204 · desktop, shared · the server diff's hot loops in WASM, in workerd

**In workerd, the WASM diff is 40–47% faster than pngjs, and it holds a sixth of the memory.** The
result is the same byte for byte: every field, and the overlay's bytes.

Three loops moved to a 26475-byte Rust module (`engines/wasm`): the unfilter, the per-pixel loop
and the region pass's blob boxes. Inflate stays on workerd's zlib, and the overlay is still encoded
by pngjs. A PNG the fast path does not read goes to pngjs. No fixture fell back in this run.

**Question.** The Cloudflare deploy cannot load native code, so PS-203's napi-image sidecar does
not apply there. Can WASM win in workerd, where jsquash's WASM decoder tied pngjs in PS-168?

**Env.** Linux desktop, 12 cores; other worktrees' gates were running (`shared`). The harness is
`apps/web/perf/diff-wasm/`, a Worker built with the Cloudflare Vite plugin and served by
`vite preview`. Two workerd processes run side by side: one serves pngjs and the encode-only probe,
the other serves wasm and an empty request. That way each process's VmHWM belongs to one
implementation. The pages are the PS-168 run's (seeds 100–102). Every pair is checked equal across
the two processes before any timing, using every field plus the overlay's sha256. Each request is
one diff, and the implementations interleave, in reverse order on odd rounds. The figures are
medians of 15 rounds after 3 warm-up rounds, taken from the client.

```bash
cd apps/web && bun perf/diff-wasm/run.ts [--rounds 15]
```

| Page | pngjs | wasm | Change | Overlay encode (pngjs) | Request alone |
| --- | ---: | ---: | ---: | ---: | ---: |
| phone | 42.4 ms | **22.6 ms** | −47% | 14.5 ms | 2.7 ms |
| desktop | 126.3 ms | **75.7 ms** | −40% | 51.8 ms | 1.6 ms |
| long | 891.8 ms | **531.7 ms** | −40% | 329.8 ms | 1.6 ms |

A second 15-round run, right after, landed within 1.5%: long 889.2 against 539.2 ms. Both
implementations pay the same encode. Taking it out, the long page is about 562 ms for pngjs
against 202 ms for wasm (−64%).

**Memory.** Both processes idled at 113–122 MB after the pages loaded. After 18 rounds, pngjs's
workerd was at 2140 MB RSS (VmHWM 2140), and it was still growing: it was 1108 MB after 4 rounds.
wasm's was at 347 MB RSS (VmHWM 434) after 18 rounds and also after 4. The pngjs process also served
the encode probe, so its figure covers pngjs's diffs and encodes together. The wasm module's memory
grows to the largest diff and stays there, which is about 300 MB for two 1440×6000 rasters, the
field and the overlay.

**Size.** The module is 26475 bytes (25.85 KiB in `wrangler deploy --dry-run`). The whole Worker is
1922.21 KiB, or 461.21 KiB gzipped, against Cloudflare's 3 MB compressed limit on the free plan
(10 MB paid).

**Recommendation.** Ship it behind the flag for every size. It is faster on every page, by more on
the smallest. It is the same answer, and it removes most of pngjs's peak. Before anyone turns it
on, the overlay encode is the next lever for workerd: on the wasm path it is 62% of the long page.
Turning the flag on is Jacobus's call, and this ticket does not make it.

**Not measured.** Cloudflare's own runtime and its CPU limits: the run used local workerd, and
nothing was deployed. Also not measured: the self-host, which diffs in PS-203's sidecar and does
not use this path.

### 2026-10-25 · PS-203 · desktop, shared · the self-host's server diff in a Bun sidecar

**The self-host's server diff is 2.5–2.7× faster, and workerd settles at about half the memory.**
On PS-200's burst the 50 diffs took 29.7 and 37.9 s in-process and 11.9 and 14.3 s through the
sidecar; workerd settled at 660 and 691 MB before and 357 and 363 MB after, under PS-200's 665 MB.
The diff now decodes and encodes with napi-image in a Bun process on loopback instead of pngjs in
workerd; the result is the same (fields equal, overlay pixels equal, `src/diff/sidecar.test.ts`).

**Env.** Linux desktop, 12 cores, load average 8 to 15 (other worktrees' gates running), browser and
editor up (`shared`). All four runs in one session, alternating. The burst is
`apps/web/e2e/rss-burst.spec.ts` against the e2e production build: 50 shots of 1280×5000 uploaded to
main, then 50 changed ones to a branch, each finalised; "diff" is the branch upload's time less
main's (main has no baseline, so it diffs nothing). Before is `PIXELSLASH_E2E_NO_SIDECAR=1` on the
same build.

```bash
cd apps/web
PIXELSLASH_E2E_NO_SIDECAR=1 PIXELSLASH_RSS_BURST=50 bunx playwright test rss-burst   # before
PIXELSLASH_RSS_BURST=50 bunx playwright test rss-burst                              # after
```

| Run | diff | branch upload | workerd idle / peak / settled | sidecar idle / peak / settled | finalises |
| --- | ---: | ---: | --- | --- | ---: |
| before #1 | 29.7 s | — | 177 / 681 / 660 MB | — | 1 |
| after #1 | **11.9 s** | — | 178 / 371 / 357 MB | 39 / 317 / 51 MB | 1 |
| before #2 | 37.9 s | 42.0 s | 181 / 725 / 691 MB | — | 1 |
| after #2 | **14.3 s** | 18.5 s | 178 / 392 / 363 MB | 35 / 343 / 58 MB | 1 |

The first pair's branch upload was not printed (the line gained it after). The load moved between
runs, so compare each after with the before beside it, not across pairs.

**Memory.** workerd's peak halves because it no longer holds pngjs's decoded rasters and overlays;
the sidecar holds them instead, and gives them back (settled 51–58 MB). Worst case, both peaks at
once, is about 735 MB against 725 MB before; settled the two together are about 420 MB against
691 MB. The sidecar's unit is capped at 450M/600M, and `pixelslash-web`'s PS-155 cap is unchanged.

**Not measured.** The CT itself (2 vCPU): the brief forbids running anything there. The desktop is
faster per core, so the CT's absolute times are higher, but the decode and encode the sidecar removes
are the same share of each diff.

### 2026-10-25 · PS-195 · desktop, shared · split settle out of capture, then cut it

**Settle is 83% of capture, and nearly all of settle is the network-idle wait** (capture-only, 10 shots:
settle 5122 of 6169 ms, network idle 4867 of those). Network idle is Playwright's fixed quiet window of
about 500 ms per page, so it is waiting, not working, and it cannot be made shorter without shooting
early. **The cut overlaps the waits instead of shortening any:** a pair's Main and Branch are shot at
once, and `capture` (and `check`) shoot up to four pages at once, each in its own browser context with
its own full settle. Capture-only total −62%, long pair −28%, 5-route pair −39%; the PNGs are byte-equal.

**Question.** PS-190 found capture is 68–93% of a real CLI run but could not say which part. Which part
of capture dominates, and can it be cut inside invariant 2?

**Env.** Same machine and fixtures as PS-190: Linux desktop, 12 cores, load average 1.4 to 2.0, browser
and editor running (`shared`). Bun 1.4.2, Playwright 1.64.1, Chromium 148 headless shell,
`fingerprint: bare`. Before is b93deff (the split, shots one at a time), after is 65668c2 (pages at once);
both in the same session, one after the other. Fixture pages from `python3 -m http.server` on :8765 and
:8766.

**Commands.** PS-190's three, unchanged, three runs each per side (`CLI=packages/cli/src/index.ts`).

**Medians over three runs, ms.** Run-level parts are sums over shots, so with pages at once they pass
`captureMs`, and `captureMs` (also a sum) passes `totalMs`. The runs were tight: every before total is
within 37 ms of its median and every after total within 24 ms, so p95 (= max of three) is left out.

| Run | | total | capture (sum) | settle (sum) | network idle | screenshot | navigate | launch | diff |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| capture only, 10 shots | before | 6630 | 6169 | 5122 | 4867 | 734 | 64 | 40 | — |
| | after | **2527 (−62%)** | 7088 | 5096 | 4814 | 1329 | 102 | 39 | — |
| long pair, 1440 × 6080 | before | 2162 | 1453 | 1021 | 965 | 327 | 13 | 39 | 694 |
| | after | **1559 (−28%)** | 846 | 1007 | 959 | 507 | 19 | 39 | 705 |
| 5-route pair, 5 shots | before | 7.4 s | 6.3 s | 5140 | 4855 | 940 | 64 | — | 1.0 s |
| | after | **4.5 s (−39%)** | 3.4 s | 5135 | 4857 | 1335 | 72 | — | 1.0 s |

The 5-route row is from the stderr line (0.1 s) and the per-route manifests; its index carries the rest.

**What moved.** Settle and network idle are the same per page before and after (every wait still runs
in full); they now overlap. Screenshot time per page rose (734 → 1329 ms summed for 10 shots) because
four pages encode at once on a shared CPU; it is still far below the wait it overlaps. Diff did not move.
Fonts, images and frames together are under 6% of settle, so they were not levers.

**Levers considered and not taken.** A shorter network-idle window (an own idle check instead of
Playwright's 500 ms) would shoot earlier than today, which invariant 2 forbids without showing pixel
equality on every page; overlapping gets more and changes nothing a page sees. More than four at once
was not measured: the capture image runs on CI runners of unknown size, and four kept screenshot
contention small here. Each shot keeps its own timeout while four share the CPU, so a page that
only just settles in time alone can now time out; none of these pages came near it.

**Pixels.** All 102 PNGs from the runs (diff.png left out) hashed identically across the three runs and
before against after. In the pinned capture image (`docker build` of `git archive` main and of the
branch), `fixtures/capture` (6 PNGs) and the PS-190 config (10 PNGs) hashed identically, PNGs and
manifest, on both, two runs each; the 10-shot capture there went from 6.3 s to 2.2 s.

**Never-settling page.** A page whose top-level `fetch` never answers still fails both a pair and
`capture` with exit 1 after 8.2–8.6 s ("capture settle exceeded 8000ms"), as before.

### 2026-10-25 · PS-190 · desktop, shared · where a real run's time goes

**diff is 13% of a real CLI run and 22% of a server build** (CLI: a 5-route pair run at 1440 wide, no
upload; server: the three finished hackcove builds, pooled. Per build the server share is 0.5%, 1.1%
and 41%, so the pooled 22% rests on one 448-shot build.)

**Tile hashes:** on the CLI, diff is 13% of the run, so removing all of the diff would move the total by
13%. Tile hashes would clear the 10% bar only if they skipped about three-quarters of the diff time, and
the routes run diffs just two of its five shots (the other three are identical bytes and never reach the
diff). On the server the answer depends on one heavy build, and three builds are too few to call it.
The next ticket should not be assumed to pay for itself on the CLI.

This is a measurement entry. No product code changed, and nothing was added to the gate or CI.

**Question.** How much of a real run is the diff, against capture and the upload? The bench times only the
diff, so until now nobody knew its share of a whole run.

**Env.** Linux desktop (12 cores, load average 1.9 to 2.2 during the runs), browser and editor running,
so `shared` in the run-log table. `--env dedicated` is for `bench:perf` and does not apply to CLI runs.
Bun 1.4.2, Playwright 1.64.1, Chromium 148 headless shell, `fingerprint: bare`: the CLI warned that it
ran outside the pinned capture image, so local fonts may skew pixels (timings are not affected by that).
Commit e875c57 (ps-190). Fixture pages came from a local `python3 -m http.server`, not the hosted app.

**Commands.** `CLI=packages/cli/src/index.ts`, run from a scratch dir outside the repo:

```bash
# capture: 5 routes x 2 variants (1440x900, 390x844), 10 shots, three runs with --json
bun $CLI capture --config capture/pixelslash.config.json --out capture/jsonN --json

# pair, one long page (1440 wide, about 6080 px tall), live and local differ in one block
bun $CLI --live http://127.0.0.1:8765/long-live.html --local http://127.0.0.1:8765/long-local.html --width 1440 --out capture/pairN

# pair, five routes (--routes), live on :8765, local on a copy with two changed pages on :8766
bun $CLI --live http://127.0.0.1:8765 --local http://127.0.0.1:8766 --routes routes.txt --width 1440 --out capture/routesN
```

Medians and p95 are over three runs. With three samples, p95 by nearest rank is the slowest run, so read
the p95 column as the maximum. Raw samples are in `bench/perf-results/ps-190/` (gitignored).

**CLI, median ms and share of the total** (the three columns of shares add up to 100%; the remainder is
under 30 ms of overhead):

| Run | total | capture (incl. settle) | diff | upload | p95 total | p95 diff |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5-route pair, 1440 wide, 5 shots, 2 changed | 7348 | 6345 · 86% | 975 · **13%** | not run | 7350 | 1003 |
| long page pair, 1440 × 6080, 1 shot | 2156 | 1456 · 68% | 691 · **32%** | not run | 2164 | 705 |
| capture only, 10 shots (5 routes × 2 variants) | 6613 | 6166 · 93% | — (no diff in capture) | not run | 6639 | — |

The capture-only total is 447 ms above its captures: browser launch and app start, which `captureMs` leaves out.

**Server (hackcove, CT 135), median and p95 ms per step.** Finished builds with `rerun = 0`, the same rows the
org Timings tab reads. Read-only `SELECT` against the server's D1 SQLite on CT 135 (`python3 -I` with `sqlite3` in `mode=ro`, over ssh and `pct exec`, per `ob hosts pixelslash`); the
Timings tab and the build page were not opened, because they need a signed-in session.

| Build | uploaded shots | queue (before diff) | diff | explain | summary | total (claim to finish) | diff share of queue + total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A, passed | 1 | 1116 | 28 | — | 4252 | 4357 | 0.5% |
| B, changes | 1 | 2851 | 238 | 3296 | 15092 | 18699 | 1.1% |
| C, passed | 448 | 17493 | 12512 | — | — | 12733 | 41% |
| **median (n = 3)** | | 2851 | 238 | 3296 (n = 1) | 9672 (n = 2) | 12733 | |
| **p95 (n = 3, = max)** | | 17493 | 12512 | 3296 | 15092 | 18699 | |
| **pooled** | | 21460 | 12778 · **22%** | | | 35789 | 22% of 57249 |

Diff share of a server build is diff over queue plus total, the whole server run from the upload's creation to
the last AI step. The pooled 22% is the one figure to quote, and only with that caveat.

**Upload.** The CLI's own upload time is in each server build's `timings` (`upload.totalMs`, which matches the
queue on build C to within 74 ms: 17419 against 17493). The CLI runs above did not upload, so the CLI's
upload share is not measured here.

**Not in the numbers, and what would fill the gap**

- **Settle is not split from capture.** `captureMs` covers page load, settle and the screenshot together.
  Proposal: a `settleMs` per shot in the timings (a field, so additive under the `/api/v1` rule).
- **CLI upload was not run.** An upload would write fixture builds into the hackcove project and into its
  Timings tab, so it was skipped. Proposal: a throwaway project for perf runs.
- **The Timings tab and the build page were not read.** Chrome was not running with remote debugging, and
  the build page redirects to sign-in without a session. The table above is the same data read from D1.
- **Three server builds are in `processing` with `finished_at` set before the claim**, so their total is
  negative and they are left out. They look stuck (or finished by a step that never moved the status), and
  the Timings tab would read them the same way. Worth a look on the server.
- **Rerun builds are left out**, as the Timings tab leaves them out. There are 33 of them, and their diff
  median is 15.7 s, which says more about re-diffing a whole build than about one run.

**Observed while measuring (not fixed here).** A `--routes` run whose route is `/index.html` fails with
`EISDIR`: its per-route directory `index.html/` collides with the run's own `index.html` report, and the
route `/` is written to `index/` instead. Repro: `--routes` file with `/index.html` in pair mode.

### 2026-10-25 · PS-168 · desktop, dedicated · decoders and encoders

`bun run bench:decoders`: every decoder and overlay candidate as one `--impl` of `bench:perf --env
dedicated`, 28 implementations, 10 interleaved rounds, one run (reserved CPUs 4-5,10-11 at about
3121 MHz, boost off). The full table, every page, licences and install weight, is
`bench/results/decoders-2026-10.md`. Long page, median ms; "self" is decode + diff, "change" is self
against the engine's own baseline row (stb sequential for C#, pngjs sequential with no overlay for TS):

| Candidate | Engine | self | change | decode | peak RSS MB | wall | Licence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| stb, sequential | cs | 318.7 | 0% | 189.5 | 168.6 | 356.1 | Unlicense or MIT |
| stb, parallel | cs | 253.1 | −21% | 120.5 | 228.6 | 290.7 | Unlicense or MIT |
| libspng on zlib, parallel | cs | 215.1 | −33% | 84.6 | 158.2 | 262.5 | BSD-2 + zlib |
| libspng on zlib-ng, parallel | cs | **147.6** | −54% | 16.9 | 158.3 | 195.0 | BSD-2 + zlib |
| Wuffs, parallel | cs | 156.6 | −51% | 26.1 | 163.7 | 202.9 | Apache-2.0 or MIT |
| SkiaSharp, parallel (**shipped default**) | cs | 163.7 | −49% | 32.7 | 161.1 | 207.2 | MIT + BSD-3 |
| ImageSharp 3.1.12, parallel | cs | 271.2 | −15% | 141.2 | 235.9 | 313.7 | Six Labors Split (paid) |
| pngjs, sequential | ts | 656.6 | 0% | 282.3 | 411.0 | 706.4 | MIT |
| pngjs, parallel | ts | 523.8 | −20% | 166.0 | 398.1 | 573.9 | MIT |
| fast-png, sequential | ts | 1188.6 | +81% | 823.2 | 399.0 | 1242.3 | MIT |
| upng-js, sequential | ts | 795.3 | +21% | 435.5 | 281.0 | 838.1 | MIT |
| sharp, sequential | ts | 465.7 | −29% | 90.2 | 274.2 | 504.0 | Apache-2.0 + LGPL-3.0 libvips |
| @napi-rs/image, sequential (**bench default**) | ts | **402.6** | −39% | 29.8 | 308.6 | 438.6 | MIT |
| @jsquash/png, parallel | ts | 528.9 | −19% | 163.1 | 282.7 | 572.2 | Apache-2.0 |
| @cf-wasm/png, parallel | ts | 2043.2 | +211% | 1657.1 | 1175.8 | 2087.9 | MIT |
| pngjs + pngjs overlay (production-shaped) | ts | 1065.2 | +62% | 274.7 | 410.4 | 1114.8 | MIT |
| pngjs + napi-image overlay | ts | 677.3 | +3% | 275.8 | 424.9 | 732.0 | MIT |
| pngjs, `bun build --compile` | ts | 643.1 | −2% | 284.4 | 472.0 | 705.4 | MIT |

- **cs ships SkiaSharp, parallel.** libspng on zlib-ng is 10% faster on self (147.6 against 163.7
  ms) and Wuffs 4%, but both need `native/build.sh` (a C toolchain, and zlib-ng built from source)
  where SkiaSharp is one NuGet package. `--decoder` keeps every candidate a switch, and `--decode
  sequential` the old mode. No paid or copyleft candidate is faster than SkiaSharp.
- **The ts bench decodes with napi-image, sequential, and encodes no overlay.** The production
  engine still decodes and encodes with pngjs. For the CLI the fastest is napi-image both ways;
  for workerd it is pngjs parallel, tied with jsquash parallel.
- **Peak RSS is self-reported** (`peak_rss_bytes`: `VmHWM`, `PeakWorkingSet64`). rusage's maxRSS of
  a child carries the parent's high-water mark through fork and exec, so it read the same on every row.
- **Could not build:** libspng or Wuffs as WASM (no maintained npm build), ImageSharp 3.2+ (needs a
  licence key), jsquash and sharp under `bun build --compile` (their .wasm and native addon are not
  embedded).
- **Parity:** cs's verdicts and regions, SkiaSharp parallel against main's stb sequential, on both
  corpora: 157 cases, 0 mismatches.

### 2026-10-24 · ob 1947 · desktop, dedicated · `--env dedicated` against `--env none`

Not a speed lever: it asks whether reserving cores, pinning memory and switching boost off makes a run
steadier. Four runs of `bun run bench:perf -- --env <none|dedicated> --impl "bun bench/src/impl/ts-diff.ts"
--impl "dotnet engines/dotnet/PixelSlash.Diff/bin/Release/net10.0/PixelSlash.Diff.dll" --runs 15`,
alternating, host load 0.6 to 2.8, nothing else started. The cell is `self p95 / self median`.

| Page | Engine | none, run 1 | none, run 2 | dedicated, run 1 | dedicated, run 2 |
| --- | --- | ---: | ---: | ---: | ---: |
| phone | ts | 1.43x | 1.06x | 1.07x | 1.02x |
| phone | cs | 1.12x | 1.07x | 1.03x | 1.05x |
| desktop | ts | 1.04x | 1.06x | 1.07x | 1.01x |
| desktop | cs | 1.05x | 1.10x | 1.02x | 1.03x |
| long | ts | 1.03x | 1.03x | 1.02x | 1.01x |
| long | cs | 1.03x | 1.05x | 1.01x | 1.01x |
| **mean · worst** | | | **1.09x · 1.43x** | | **1.03x · 1.07x** |

With `--runs 5` (two runs each, 12 cells per env) the gap is too small to call: mean 1.04x, worst
1.14x with `none`; mean 1.03x, worst 1.07x with `dedicated`. Fifteen rounds is the minimum that shows it.

- **Steadier, not faster.** Boost off holds the reserved cores near 3.2 GHz (min 1.7, max 4.6 GHz during
  the run) and wall medians are 1.2x to 1.4x slower than `none` (`--runs 5`: ts desktop 258 ms against
  353 ms, cs desktop 104 ms against 130 ms). Compare engines inside one env; never a `dedicated` number
  against a `none` one.
- **Foreign tasks on the reserved cores** were 0 in two runs, one `systemd[1]` in another, and one
  kernel worker (`kworker/5:4+events`) in the fourth. The sampler counts running threads outside the
  scope on those CPUs every 250 ms.
- The machine was quiet (load under 3), so `none` was already steady except for one 1.43x outlier.
  The reservation matters most when the browser or a build is running; that case was not measured.
- Engines keep their order in both envs, but the gap is not the same: cs against ts on phone wall is
  −28% with `none` and −42% with `dedicated`, because ts is the engine that slows most with boost off.

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

The ts diff includes encoding the overlay PNG, and cs encodes none, so "change" is not equal work:
it credits cs for skipping the encode. For an equal-work comparison see the dashboard (PS-168, ts
with `--overlay none`).

### Tooling history

- ob 1790: `bench:perf`, this tree against a base, interleaved, with a check that fails on more than 25% slower.
- ob 1909: the language-neutral diff contract, and `--impl` for timing engines against each other.
- ob 1910: the C# engine behind the contract.
- ob 1932: per-phase timings, `startup_ms`, `--decode parallel|sequential`.
- ob 1947: `--env dedicated`, reserved cores and memory for the run, and the `env` header in every result.
- PS-168: `bench:decoders`, `--decoder` on both engines and `--overlay` on ts, `peak_rss_bytes` in the contract.
