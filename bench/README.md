# bench: PixelSlash against Argos

A re-runnable benchmark of **what gets flagged** (ob 1477): the same labelled screenshot pairs go
through PixelSlash's diff and through Argos's image comparison, and both are scored the same way.
Argos is a benchmark rival, never a code source; it runs only through `ops/argos-bench/`.

```bash
bun run bench                      # PixelSlash + Argos (from the cache), writes bench/results/<date>.{md,json}
bun run bench -- --refresh-argos   # ask the Argos VM about the pairs the cache lacks, then run as above
bun run bench -- --calibration     # plus Argos's own 19 calibration cases, streamed from the VM
bun run bench -- --no-argos        # PixelSlash alone, prints the tables, writes nothing
bun run bench -- --capture         # plus the capture stage: needs Docker, skipped with a message without it
bun run bench -- --impl "<cmd>"    # score an outside implementation (see "The diff contract"); writes nothing
bun run bench:check                # regression guard: PixelSlash against the last results file
bun run bench:perf                 # speed, before vs after on this machine (see "Speed"); on demand only
bun run bench:perf:check           # the same comparison; exits 1 when a step is over 25% slower
bun run bench:perf -- --impl "<cmd>" --impl "<cmd>"   # time implementations against each other
bun run bench:native               # diff.wasm's steps in wasm and natively (needs cargo; PS-212)
bunx nx run bench:corpus           # re-render the main corpus (needs chromium-headless-shell)
bun bench/src/generate.ts --set holdout   # re-render the held-out corpus
```

**No VM is needed to run the benchmark.** Argos's verdicts for every pair are in
`bench/argos-cache.json` (verdict, score, time and changed regions) and `bench/argos-cache/diffs/`
(its diff images). An entry is keyed by the pair's content hash, the Argos commit pinned in
`ops/argos-bench/Dockerfile` and the threshold, so a re-rendered or new pair is a miss, never a
stale hit. A miss fails `bun run bench` and names the cases. `--refresh-argos` fills the misses
and drops entries no case uses any more; that is the only time the VM is needed. It refuses to
mix versions: if the VM's image is not built from the pinned commit, it stops.

For `--refresh-argos` the VM must be up (`ssh root@$SSH_HOST "qm start $VMID"`, and
`qm shutdown $VMID` afterwards: it holds 2 GB on a tight host; `ops/argos-bench/runbook.md`). The
address and key come from `ARGOS_BENCH_HOST` and `ARGOS_BENCH_KEY`, the same variables
`ops/argos-bench/run-pairs.sh` reads. The per-pair Argos time in the cache was measured by the
wrapper in `ops/argos-bench/argos-diff.ts`, which is baked into the image. `--calibration` adds
Argos's own 19 cases as a second section; their images are streamed from the VM for the run and
never stored in this repo, and the cache holds nothing of theirs but its answers about our pairs.

## Two corpora

| | main | held out |
| --- | --- | --- |
| directory | `bench/corpus/` | `bench/corpus-holdout/` |
| cases defined in | `src/cases.ts` | `src/holdout-cases.ts` |
| pages | `bench/fixtures/` (dashboard, form, article, `fixtures/pages`) | `bench/fixtures-holdout/` (settings, pricing, inbox) |

The held-out corpus has the same categories on three pages the main corpus never uses, and at least
as many cases. **Tuning work (diff v2, regions, shift) looks at the main corpus only**: it reads
those cases, their diffs and `disagreements.html` for them. The held-out corpus is read only through
its numbers, side by side in every table of the results file, to see whether a change helped beyond
the pages it was tuned on. A change that moves main and not held-out is probably overfit. If a
held-out case is ever opened to understand a miss, say so in the commit: it is no longer held out
for that fix, and the pages should be replaced.

## The capture stage

The corpus cases are image pairs, so a caret, an animation frame or a clock in them is scored against
the diff alone. In the product the capture stage is meant to remove that noise before any diff runs
(animations off, caret hidden, frozen clock and page timers, settled page; the pinned image in `docker/capture`).
`bun run bench -- --capture` measures that stage on its own and adds a "Capture stage" section to the
results (Argos is not involved; its capture SDK is not run).

`bench/fixtures-capture/` holds six pages: a CSS animation, a shimmer skeleton, a focused input with a
caret, `Date.now()` and relative-time text, a carousel on a timer, and a slow plus a `loading="lazy"`
image. Each page is captured in pairs with `pixelslash capture` and each pair diffed with the engine
(`diffPngs`); the cell is how many pairs were flagged when nothing on the page changed. Three arms:

| arm | how | why it is there |
| --- | --- | --- |
| pinned image | `docker run --network host pixelslash-capture:dev capture` (built from this tree first; layers are cached) | the claim: 0 false changes |
| bare | the same CLI on this machine | what the same stabilisation does outside the image |
| control | bare, with animations, caret and clock left alone | proof the page flickers at all: a clean image row means nothing if the control is clean too |

The settle (fonts, images, network idle, two frames) runs in every arm: it is not optional, so a
page it alone makes stable (`lazy-image`) cannot flicker in the control. `caret` did not flicker in it
either, which fits headless Chromium painting no caret (above), though three pairs do not prove that.
The results say which pages the control did not flag. The
animated pages start at a random point in their cycle, which stands in for the jitter in load timing
between two CI runs: on an idle machine a capture lands on the same frame every time. Some noise is
a coin toss per capture (the carousel), so each arm takes three pairs instead of one.

A page the image still flags is named in the results, with where the diff is and what its noise is.
That is a finding, not a failure of the run: capture defaults are not changed here. Without Docker the
stage prints `capture: skip: <why>` and the rest of the run goes on.

## Speed: before vs after (`bench:perf`)

`bun run bench:perf` answers one question: **did this branch get slower than main, on this machine,
right now?** It is not part of the accuracy benchmark above and shares nothing with its guard.

```bash
bun run bench:perf                       # head against origin/main (else main), 10 rounds
bun run bench:perf -- --base <ref>       # against any ref; --base HEAD compares a tree with itself
bun run bench:perf -- --runs 5           # fewer rounds
bun run bench:perf -- --only diff-phone,capture
bun run bench:perf:check                 # same run; exit 1 if any step's head median is >25% slower
```

It times eight steps, with the warm-up discarded, and reports the median and p95 in ms:

| Step | What is timed |
| --- | --- |
| `diff-phone`, `diff-desktop`, `diff-long` | `diffPngs` (decode, diff, region clustering) on a 390x844, a 1440x900 and a 1440x6000 pair |
| `diff-long-small`, `diff-long-shift` | `diffPngs` on the long page against itself with one 40x16 badge recoloured, and with its lower half drawn 10 px down: the case tile hashes are for and their worst case (PS-191) |
| `diff-identical` | `diffPngs` on the long page twice, the same file: the byte-equal shortcut (ob 1948) answers without decoding, so a tree without it pays the whole diff for "no change" |
| `capture` | the real Playwright settle path (`settleCapture` plus a full-page screenshot) of a fixed page served by `Bun.serve` on localhost |
| `server-build` | the web app as the e2e starts it (production build, `vite preview`, a fresh local D1, GitHub stubbed): ten 800x600 shots uploaded and finalised, timed from the start of the build to the verdict |

The fixtures are drawn from a fixed seed and written once per run, so base and head read the same
bytes; none is over about 1 MB.

**Why interleaved.** A speed number is only meaningful next to another taken at the same moment.
The desktop is busy and its load drifts by minute, so a base measured ten minutes before the head
would be comparing the machine's mood. The runner checks the base out into a temporary git
worktree (`~/.cache/pixelslash-perf/base-<pid>`, not `/tmp`), runs `bun install` there, and then
alternates base, head, base, head... for `--runs` rounds in one invocation. Each round's
sample goes into the base or the head list, and the report compares their medians, so a slow patch
of the machine hits both sides. The measuring code (`bench/src/perf/`) is copied into the base
worktree, so the same probe times each tree's own engine and web app. The worktree is removed when
the run ends, on failure, on SIGINT and on SIGTERM; a run that was killed with SIGKILL leaves its
directory, and the next run removes it.

**The check.** `bench:perf:check` fails (exit 1) naming the step and both medians when a step's head
median is more than 25% above the base median *in that run*. It never reads an earlier run. With no
`--base` and neither `origin/main` nor `main` available it prints the head timings alone, says no
comparison was made, and exits 0. An unknown `--base` ref is a usage error (exit 2). Both root scripts
run `bun bench/src/perf/run.ts` directly, so those exit codes reach the caller (through `nx run` every
failure would read as 1). The head side times the working tree; the head SHA in the report and the
results file carries `+dirty` when the tree has uncommitted changes.

**How much to trust it.** Compared with itself (`--base HEAD`, 10 rounds) the diff and capture steps
land within about 4% of each other on this desktop; `server-build` is the noisiest, up to about 15%,
because it starts a server and a database, so a 25% limit leaves it only a little room. Re-run a
step that fails before believing it (`--only server-build`).

**On demand only.** Nothing here is in `bun run test`, `lint`, the gate or any land step: a speed
run takes minutes and is only worth reading when the machine is quiet. Each run writes its numbers
to `bench/perf-results/<time>.json`, which is gitignored; nothing is committed and nothing reads
old results.

To see the check fail, slow the diff on head only: `PIXELSLASH_PERF_SLOW_DIFF_MS=300 bun run
bench:perf:check -- --base HEAD --only diff-phone` adds 300 ms inside the timed diff and fails on
`diff-phone`.

## The diff contract: comparing an engine in another language

A Rust, Go or C# engine can be scored and timed here without touching this repo's code, if it
answers one command:

```
<impl> diff <base.png> <head.png> --json
```

It prints **one JSON object** on stdout and nothing else (stderr is free for logs):

```jsonc
{
  "verdict": "changed",                      // "changed" | "unchanged"
  "regions": [{ "x": 10, "y": 40, "w": 200, "h": 32 }],   // changed regions, base-image pixels
  "decode_ms": 3.1,                          // the implementation's own clock: reading + decoding both PNGs
  "diff_ms": 12.4                            // its own clock: comparing and clustering into regions
}
```

```json
{
  "type": "object",
  "required": ["verdict", "regions", "decode_ms", "diff_ms"],
  "properties": {
    "verdict": { "enum": ["changed", "unchanged"] },
    "regions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["x", "y", "w", "h"],
        "properties": {
          "x": { "type": "integer", "minimum": 0 },
          "y": { "type": "integer", "minimum": 0 },
          "w": { "type": "integer", "minimum": 1 },
          "h": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "decode_ms": { "type": "number", "minimum": 0 },
    "diff_ms": { "type": "number", "minimum": 0 }
  }
}
```

**Optional: `startup_ms` and `phases` (ob 1932).** An implementation may also print where its
time went; an output without them still conforms, and nothing reads them but the perf table:

```jsonc
{
  "startup_ms": 41.2,                        // spawn stamp to its first line of engine code
  "peak_rss_bytes": 104857600,               // its own peak resident set as it finishes (PS-168)
  "phases": {                                // ms per named phase, each >= 0
    "decode_read": 0.4, "decode_inflate": 9.1, "decode_unfilter": 2.3, "decode_other": 1.0,
    "pixel_compare": 5.0, "anti_alias": 1.2, "regions": 0.6
  }
}
```

```json
{
  "startup_ms": { "type": "number", "minimum": 0 },
  "peak_rss_bytes": { "type": "integer", "minimum": 0 },
  "phases": { "type": "object", "additionalProperties": { "type": "number", "minimum": 0 } }
}
```

`decode_ms` and `diff_ms` keep their meaning and stay required. The phase names:

| phase | inside | what it is |
| --- | --- | --- |
| `decode_read` | `decode_ms` | reading both files |
| `decode_inflate` | `decode_ms` | the zlib stream |
| `decode_unfilter` | `decode_ms` | the per-row PNG filters |
| `decode_other` | `decode_ms` | the remainder: chunk walk, copying out, colour-type conversion, and whatever the decoder hides |
| `pixel_compare` | `diff_ms` | the YIQ threshold loop |
| `anti_alias` | `diff_ms` | the anti-alias test on pixels over the threshold; an engine that cannot separate it leaves it out and `pixel_compare` includes it |
| `regions` | `diff_ms` | 24 px grouping plus the speck, noise and shift rules |
| `overlay_encode` | `diff_ms` | the overlay PNG; only an engine that encodes one reports it (none in the bench does since PS-211) |

An engine reports the phases it can and leaves out the rest. The `diff_*` phases and `decode_*`
phases add up to their `_ms` apart from the clock reads between them; the sums are the check that
nothing is unaccounted for.

`startup_ms` is measured from a stamp: the harness puts the epoch time in ms (fractional) in the
environment variable `PS_BENCH_SPAWN_AT` just before it spawns the process, and an engine reports
the epoch time of its first line of engine code minus that. That is the process spawn, the runtime's
boot and module load. It is used instead of timing a no-op run of the same command (which would
need a second contract verb, and would measure a different process): it is the same process, in the
same run. An engine run by hand has no stamp and omits `startup_ms`. The perf table then gives
`rest` = wall - `startup_ms` - `decode_ms` - `diff_ms`: exit, the JSON write, and the harness's own
pipe read.

`peak_rss_bytes` (PS-168, optional) is the process's own peak resident set, read as it finishes
(`VmHWM` in `/proc/self/status` on Linux); the perf table prints its median. The harness does not
take it from the child's rusage, because Linux carries the parent's high-water mark through fork
and exec, so every child would report at least the runner's own size.

**`--decode parallel|sequential` (ob 1932).** The harness appends it after `--json` when
`bench:perf -- --impl ... --decode <mode>` is given; an implementation that supports it decodes the
base and head at the same time for `parallel` and one after the other for `sequential`, its default.
The verdict and regions are the same either way (a test holds that for the TypeScript implementation
on both corpora). In parallel `decode_ms` is the wall time of the decode, and the `decode_*` phases
are summed work over both files, so they add up to more than `decode_ms`. An implementation that
does not know the flag may exit 2, which the harness reports as a failure.

Extra fields are ignored. `regions` holds only the regions that **changed** (no "shift" or other
kinds), may be empty, and is empty when the verdict is `unchanged`. `decode_ms` and `diff_ms` are
**self-timed inside the process**, so start-up (a JVM, a dotnet runtime, a dynamic linker) is not in
them; the harness measures wall time around the whole process separately.

**Exit codes.** `0`: the JSON was printed (whatever the verdict; "changed" is not an error). Any
other code is a failure of that pair and its stderr's first line is reported. By convention `1` is
an unreadable or undecodable image and `2` is bad usage; the harness treats all non-zero codes
alike. A wrong object, text that is not JSON, a process that cannot start and a process that runs
past the timeout (`--timeout-ms`, default 60000; it is killed) are failures too. A failure is
reported against that case, by name, and the run goes on with the next one.

`<impl>` is a command line split on whitespace (no quoting), so `./target/release/pxdiff` and
`bun bench/src/impl/ts-diff.ts` both work. It runs from the repo root.

**The reference implementation** is `bench/src/impl/ts-diff.ts`: the engine's diff behind the
contract. It is the baseline, and the first thing to run to check the harness. It runs `wasmDiff`,
the one diff the CLI and the server run (`diff.wasm`, PS-210), so the verdict and regions are the
engine's. It reads the two files, then one call does inflate, unfilter, the pixel loop and the
regions; the call times its own steps (PS-212), so `decode_ms` is the read plus the call's
`decode_inflate`, `decode_unfilter` and `decode_other`, and `diff_ms` is the rest of the call, split
into `pixel_compare` (the anti-alias test included) and `regions`. No overlay image is encoded: the engine's encode is
a no-op here, since the contract does not ask for one, so the JS side does not pay for work C# never
does. A cold process is slower than the warm in-process loop of
`bench:perf` (roughly 1.7x here, from JIT warm-up), so numbers from the two modes are not
comparable.

`--engine wasm` (PS-209's spelling) is still accepted, so a recorded command runs. Any other
`--engine`, and `--decoder` and `--overlay`, are usage errors: the pngjs and napi-image engines, and
their decoders and overlay encoders, are gone (PS-210, PS-211). The runner's `--decode` is accepted
and ignored. When the WASM diff landed (PS-209) its verdict and
regions matched the pngjs reference on all 157 pairs; since PS-210 it reads every PNG pngjs read,
and `packages/engine/test/fixtures/pngjs-golden.json` holds pngjs's whole result, overlay included,
for each of them.

### Scoring: `bench -- --impl`

```bash
bun run bench -- --impl "bun bench/src/impl/ts-diff.ts"
bun run bench -- --impl ./pxdiff --timeout-ms 20000
```

Runs the implementation over every pair in both corpora and scores it with the same rules as
PixelSlash's own diff, in the PixelSlash columns of the usual tables; Argos's column is the cache,
as before. The reference implementation gives the same accuracy numbers as plain `bun run bench`.
Without `--impl` nothing changes. With it:

- it **writes nothing**: `bench/results/*.json` stay the `bench:check` baseline and are never
  overwritten by an outside implementation;
- a failing pair is listed by case name with its reason and left out of the scores; the exit code
  is 1 if any pair failed (a run where every pair failed stops with that message);
- it cannot be combined with `--calibration`, `--capture` or `--refresh-argos` (that one writes the Argos cache).

### Timing: `bench:perf -- --impl`

```bash
bun run bench:perf -- --impl "bun bench/src/impl/ts-diff.ts" --impl ./pxdiff
bun run bench:perf -- --impl ./a --impl ./b --only diff-long --runs 5
```

Compares **implementations**, not git refs (the ref comparison above is unchanged). Each takes the
phone, desktop and long diff fixtures and the long page's two small changes, one process per measurement, interleaved
(implementation A, then B, per step, per round) after one discarded warm-up round. For each step
the table shows the medians of `decode_ms`, `diff_ms`, their sum (`self`), the wall time around
the process, `self`'s p95 and each implementation's `self` against the first. When an
implementation reports `phases`, a second table per step gives its medians for the decode, each
phase, `startup`, `rest` and `wall` (a `-` where an implementation does not report one), and
`--decode parallel|sequential` is handed to every implementation. The numbers in
`bench/perf-results/` carry the same lists per sample (`startup`, `rest` and `phases`), and the
decode mode. A failing
implementation shows `FAILED: <reason>` for that step, the others are still timed, and the exit
code is 1. Two copies of the same implementation land within noise of each other. It cannot be
combined with `--check` or `--base`; `--only` takes the `diff-*` steps. It is on demand only, like
the rest of `bench:perf`, and numbers go to the gitignored `bench/perf-results/`.

### A quiet machine: `bench:perf -- --env dedicated`

```bash
bench/env/install.sh        # once: asks first, then needs sudo
bun run bench:perf -- --env dedicated --impl "bun bench/src/impl/ts-diff.ts" --impl ./pxdiff --runs 5
```

The desktop is shared with a browser and an editor, so a shared-run spread (p95 over the median, the
`p95/med` column) can be large. `--env dedicated` reserves whole cores for the run: CPUs 4,5,10,11 by
default (`--env-cpus`; a core and its SMT sibling go together, and the host keeps at least two CPUs),
and 4G of memory (`--env-mem`, at most half the machine's; set as both `MemoryMin` and `MemoryMax`, no swap). The default is
`--env none`, which measures the machine as it is. It needs `--impl` (the ref comparison builds the web
app and is not timed this way).

What the runner does, through the one root helper `pixelslash-bench-reserve on|off|status`:

- sets `AllowedCPUs` on `system.slice`, `user.slice` and `init.scope` to the other CPUs (`--runtime`,
  so a reboot also undoes it) and moves the runner itself into `pixelslash-bench.scope`, limited to
  the reserved CPUs, so every child it starts runs there;
- turns boost off (`/sys/devices/system/cpu/cpufreq/boost`) and keeps the performance governor;
- restores all of it at the end, on SIGINT or SIGTERM and after a failure. The helper writes its
  prior values to `/run/pixelslash-bench/state.json` before changing anything, and `off` is a full,
  repeatable restore from that.

If a run was killed so hard that nothing could restore (`kill -9`), the reservation stays until a
reboot (`--runtime`) or an `off`: the next `--env dedicated` refuses to start and says so. Restore with
`sudo -n /usr/local/sbin/pixelslash-bench-reserve off`.

**The helper.** `bench/env/install.sh` builds it (`bun build --compile`, as you), prints what it will
change, asks, and then installs the binary root-owned at `/usr/local/sbin/pixelslash-bench-reserve` and
one sudoers line, `NOPASSWD` for that binary only (checked with `visudo -cf` first).
Reinstalling first runs `off` with the installed helper, so a reservation is never left under a replaced binary. `bench/env/install.sh --uninstall` removes both. The helper takes no free-form input: the CPU list,
memory size and pid are validated, `--pid` must belong to the user who ran sudo, and the commands it
runs have fixed arguments. If it is not installed, `--env dedicated` is a usage error naming the install
command; it never falls back to a shared run.

**What the result says.** Every `bench/perf-results/*.json` and the printed header carry the env: its
name, the CPU model, the reserved CPUs, memory min and max, boost, governor, the frequency the
reserved cores measured (`scaling_cur_freq`), the host load at the start and end, the kernel, and the
Bun and .NET versions. A sampler outside the scope reads `/proc/*/task/*/stat` four times a second and
counts the threads that were running on a reserved CPU and are not the bench's (`other tasks seen`).
The goal is 0. Per-CPU kernel threads (`ksoftirqd`, `kworker`, `migration`) cannot be moved by a cpuset;
they are listed by name, not counted, and so are hardware interrupts, which a cpuset does not steer
either.

**The next step up** is what this does not do, because it needs a reboot: the kernel boot parameters
`isolcpus=` and `nohz_full=` (with `rcu_nocbs=`) keep the scheduler tick and RCU callbacks off the
reserved cores too, and `irqaffinity=` moves the interrupts away. Use them if the spread with
`--env dedicated` is still not low enough.

### The two engines: what `bench:perf` times

Since PS-211 the bench times two engines, one diff each:

| engine | what it is | how to run it |
| --- | --- | --- |
| `ts-diff`, `--engine wasm` | `diff.wasm` through `wasmDiff`, the one diff the CLI and the server run (PS-210) | `bun bench/src/impl/ts-diff.ts diff <base.png> <head.png> --json` |
| C#, `PixelSlash.Diff` | the diff ported to C# (see below) | `dotnet build engines/dotnet/PixelSlash.Diff -c Release`, then `dotnet engines/dotnet/PixelSlash.Diff/bin/Release/net10.0/PixelSlash.Diff.dll diff <base.png> <head.png> --json` |

Time both in one interleaved run (on demand, never in the gate):

```bash
bun run bench:perf -- --runs 1 --impl "bun bench/src/impl/ts-diff.ts --engine wasm" \
  --impl "dotnet engines/dotnet/PixelSlash.Diff/bin/Release/net10.0/PixelSlash.Diff.dll"
```

With no `--impl`, `bench:perf` still compares two git refs (`--base`, the land-time check); the
engines are timed with `--impl`.

### The C# implementation: `engines/dotnet`

`engines/dotnet/PixelSlash.Diff` is the TypeScript engine's diff ported to C# (.NET 10) behind the
contract: the same YIQ threshold, anti-alias test, 24 px region grouping, speck, noise and shift
rules, and the same overlap-only rule for shots of different sizes. PNGs are decoded with
SkiaSharp (MIT, Skia BSD-3), base and head at once, since PS-168; `--decoder stb --decode
sequential` is the StbImageSharp (Unlicense or MIT) path it had before. See "Decoders and encoders". `engines/dotnet/PixelSlash.Diff.Tests` holds its xunit tests on
tiny rasters. Both are Nx projects through `@nx/dotnet`, named after their `.csproj`, so
`bun run test` builds and runs them. It needs the .NET SDK that `global.json` pins (see AGENTS.md).

```bash
bunx nx build PixelSlash.Diff --configuration release   # or: dotnet build engines/dotnet/PixelSlash.Diff -c Release
bun run bench -- --impl "dotnet engines/dotnet/PixelSlash.Diff/bin/Release/net10.0/PixelSlash.Diff.dll"
bun run bench:perf -- --impl "bun bench/src/impl/ts-diff.ts" \
  --impl "dotnet engines/dotnet/PixelSlash.Diff/bin/Release/net10.0/PixelSlash.Diff.dll"
```

When it landed (ob 1910), its accuracy tables matched the reference implementation's on both
corpora, row for row, and its verdict and region boxes matched on every one of the 157 pairs.
Nothing keeps that true: a change to the TS diff (`diff.ts`, `regions.ts`, `shift.ts`) is not
ported by itself, so port it and run the bench with both `--impl`s again. Two differences in what it does:
it has no ignore areas (the contract has none), and it does not encode an overlay image, and neither does the
bench's WASM reference since PS-211, so the two do equal work. The parity is for 8-bit PNGs, which is every shot in both corpora
and what a browser screenshot is: StbImageSharp and pngjs round a 16-bit sample down to 8 bits
differently, so a 16-bit pair can differ by one level before the diff starts.

**Phases in C# (ob 1932).** `Stopwatch` brackets the same boundaries as the TypeScript side, with
`anti_alias` timed on its own (a clock read around each test, so the `pixel_compare` loop minus it
is reported). StbImageSharp's `ImageResult.FromMemory` is one call, so `PngDecode.cs` takes the steps
stb itself takes, through stb's code: it walks the chunks, inflates through stb's public zlib entry
point and unfilters through `stbi__create_png_image_raw`, which stb made public but with an internal
first parameter type, so that one call is by reflection. No decoder is added or swapped, and a test
holds the output byte-identical to `FromMemory` for every PNG in both corpora and `fixtures/ds`. The
thin path takes only 8-bit, non-interlaced RGB or RGBA without tRNS; any other PNG goes through
`FromMemory` whole, reports `decode_read` and `decode_other` only, and leaves out the inflate and
unfilter phases. `--decode parallel` is `Task.WhenAll` over the two files (each read and decode on its own task).

Two things the C# split cannot show cleanly, so read `decode_other` with them in mind. The runtime
starts in tier-0 JIT, so the first image through a freshly started process pays for compiling
stb's row loops, and that time lands in whichever phase runs the code first (mostly `decode_other`
and `decode_unfilter`); a long-lived process would not. And `decode_other` includes the copy out of
stb's buffer and the RGB to RGBA expansion, which stb does inside `FromMemory` too.

### Decoders and encoders: `bench:decoders` (PS-168)

The C# implementation takes a decoder by name. The production engine (`packages/engine`) is not
touched by it and decodes and encodes inside `diff.wasm`, so there is no decoder to pick there. The
TS decoder and overlay-encoder rows (PS-168) went with the engines they served: the TS decoders in
PS-210, the overlay encoders in PS-211. Their numbers stay in `PERF.md`.

```bash
bun run bench:decoders -- --env dedicated            # every candidate below, written to bench/results/decoders-<yyyy-mm>.md
engines/dotnet/native/build.sh                        # once: libspng (zlib and zlib-ng) and Wuffs, into native/out/
<csharp> [--decoder stb|spng|spng-zlibng|wuffs|skia] diff a.png b.png --json [--decode parallel|sequential]
bun bench/src/impl/ts-diff.ts [--engine wasm] [--no-tiles] diff a.png b.png --json
```

Each switch is given at most once, before `diff` (how `--impl` passes an implementation's own
flags) or after the operands (where the harness puts `--decode`). An unknown name is exit 2, and a
decoder whose library is not built or not compiled in is a usage error, never a silent fallback.
Every C# decoder must give the baseline's RGBA byte for byte (StbImageSharp): a gate test decodes
every PNG in both corpora and `fixtures/ds` with each one that is present.

| engine | decoder | licence | where it runs | how it gets here |
| --- | --- | --- | --- | --- |
| C# | `skia` (default, parallel) | MIT (SkiaSharp), BSD-3 (Skia) | C# | NuGet |
| C# | `stb` | Unlicense or MIT | C# | NuGet; the only one that splits its decode into phases |
| C# | `spng`, `spng-zlibng` | BSD-2 (libspng), zlib (zlib, zlib-ng) | C# | `native/build.sh` |
| C# | `wuffs` | Apache-2.0 | C# | `native/build.sh` |

`native/build.sh` fetches each library's source at a pinned sha256 into
`~/.cache/pixelslash-native`, builds it with the system `gcc` and writes `native/out/*.so`
(gitignored). It needs the network once. Without it, the decoder tests skip the native decoders
and the C# default still runs: that is why the default is `skia`, the fastest permissive decoder
that comes from NuGet, and not `spng-zlibng` or `wuffs`, which measured faster (`bench/PERF.md`).

`bench:decoders` builds the C# engine, then runs
`bench:perf --impl` over every C# decoder in one interleaved run (its flags,
such as `--env dedicated`, `--runs` or `--only`, go through). The TS impl's `bun build --compile`
start-up row went in PS-210: a compiled binary does not carry `diff.wasm`, which the engine reads
from disk. Peak RSS is what each process reports as `peak_rss_bytes` (its own `VmHWM`), because the
kernel's rusage for a child carries the parent's high-water mark through fork and exec.

## The regression guard

`bun run bench:check` (an Nx target, `bench:check`) runs PixelSlash on both corpora, reads the
committed `bench/results/<date>.json` at git HEAD, and exits 1 when, on either corpus, real changes
caught fall, or noise or identical pairs flagged rise. Fractions are compared exactly (a corpus that
grew compares by rate). It prints every number before and after, and the cases whose verdict moved.
It needs no VM and no browser.

It is in the gate: `bench:test` depends on `bench:check`, so `bun run test` (and `nx run-many -t test`)
runs it and fails on a regression. The check is cacheable. Its inputs are `bench/src`, the committed
corpora, `bench/results/*.json`, `bench/package.json`, `bun.lock` and the engine's diff sources
(`index.ts`, `diff.ts`, `diff-options.ts`, `regions.ts`, `shift.ts`); an edit to any of them re-runs it,
and an edit anywhere else (`apps/web`, the CLI) replays it from cache.

When a score moves on purpose (a threshold you meant to change, a new case): run `bun run bench:check`,
read the before and after numbers, then run `bun run bench` to write a new `bench/results/<date>.json`
and commit it in the same change. That file becomes the baseline; the next check compares against it.
Do not loosen `check.ts` to make a regression pass.

## The corpus

`bench/corpus*/<case>/{base.png,head.png,label.json}`, committed. `src/cases.ts` and
`src/holdout-cases.ts` define every case and `src/generate.ts` renders them with Playwright's
Chromium from the pages of their set, so they can be regenerated; the benchmark itself reads the
committed PNGs and needs no browser. To add a case, name it: `bun bench/src/generate.ts [--set
holdout] <part-of-name>` renders just that one, so the committed ones are not re-rendered. Fonts and anti-aliasing come from the machine that rendered them, so a
re-render on another machine gives a different corpus, not a different benchmark. Even on one
machine a re-render can move a few pixels in a case or two (Chromium repaints inputs on tile
threads), which is why the PNGs are committed and the benchmark never re-renders them.

| label | meaning | how the cases are made |
| --- | --- | --- |
| `identical` | the same page rendered twice | no change |
| `noise` | a difference nobody should be asked to review | font hinting and LCD anti-aliasing (a fontconfig file per side), glyph positioning, sub-pixel layout shift, a caret, a paused animation at another frame, +-1/2 channel drift on some pixels, JPEG round-trip at 95 to 50, WebP at 90 to 75, gradient banding (band edges a pixel apart), a box-shadow drawn a little differently, emoji (colour-font) glyphs on another sub-pixel |
| `real` | a change somebody should see | 1px spacing, colour shifts from large to barely visible, text change, missing element, icon swap, layout reflow, the page growing taller, and the finest: 1px of border, one step of one colour channel (`colour-1step`), one changed glyph |

`colour-1step` is the floor of "real": a change of 1/255 in one channel is a change a person cannot
see, and it is `real` because a visual-review tool that says "unchanged" about it has stopped
being exact. A tolerant diff is expected to miss it; the kind exists so that price is visible.
Skia quantises a blur radius, so the shadow cases step from 8px to 9.5px: a finer step draws
identically and would not be a pair.

A `real` case carries a ground-truth box: the union of the rects of the elements it touches, taken
from the DOM in both renders. The caret is a 1px bar, because headless Chromium does not paint the
real one.

## Imported cases

`bun run bench:import-flags` (ob 1734) turns the detection flags reviewers leave on the snapshot
page into cases, so the diff is fixed against real misses and stays fixed. It is our tooling for
tuning the diff, not a `pixelslash` command.

```bash
bun run bench:import-flags [--server URL] [--project ID|NAME]   # the flags not yet exported
bun run bench:import-flags [--server URL] [--to DIR] <flag-id>...   # import them
```

The server is `--server`, else `PIXELSLASH_SERVER`, else the one server `pixelslash login` stored a
token for. The token is `PIXELSLASH_TOKEN`, else that stored one, and it must be a personal token
(`psu_…`): each imported flag is marked exported on the server
(`POST /api/v1/detection-flags/:id/exported`), and only a person does that. The list then shows only
what is still unworked; a reviewer editing a flag clears the mark.

Each flag becomes `<to>/flag-<kind>-<shot>-<id>/{base.png,head.png,label.json}`, in the corpus's
format. `<to>` defaults to `bench/imported/`, which git ignores. A `missed` flag is a `real` case whose
box is the rect the reviewer drew; a missed flag with no rect still imports, with the whole image
as the box, and the script says so. A `false_positive` flag is a `noise` case: not changed. The
flag itself (id, note, who, the shot, the source build, what the diff measured, `box_from`) is kept
under `flag` in `label.json`; the bench ignores it. A flag on a new shot has no baseline and is
not imported.

Nothing is added to the committed corpus automatically. To keep a case:

1. Look at it: the two PNGs, and whether the label is right. A reviewer's rect is the area they
   meant, not a measured box; tighten it if the IoU should mean something.
2. Choose a corpus. A case you are about to tune against goes in `bench/corpus/`. One that should
   tell whether a fix generalises goes in `bench/corpus-holdout/`, and is then read only through
   its numbers (above).
3. `git mv`, or `mv bench/imported/<case> bench/corpus/` and `git add` it. The case is loaded by
   directory; it needs no entry in `src/cases.ts`, and `generate.ts` never re-renders it.
4. `bun run bench`, then commit the new `bench/results/<date>.json` with the case (a new case
   moves the counts). The Argos cache has no entry for it, so `bun run bench` stops until
   `--refresh-argos` asks the VM; `--no-argos` scores PixelSlash alone and writes nothing.

From then on `bench:check` guards it: a later change that loses it on the case's corpus fails the gate.

## How it is scored

- **Verdict.** PixelSlash: `changed` from `diffPngs` at its defaults (perceptual threshold, anti-aliased edges not counted, a size mismatch always changed). Argos: score above 0
  (`diffImages`, threshold 0.5). Nothing is tuned for the benchmark.
- **Results file.** `bench/results/<date>.md` for people, `<date>.json` for `bench:check`: both
  corpora, each tool, per-corpus counts and PixelSlash's verdict per case.
- **Regions.** PixelSlash's are the engine's own (`packages/engine/src/regions.ts`: changed pixels
  and boxes within 24px merge, a box under 4px area is a speck, and `noise` regions are left out of
  the IoU). Argos returns only a diff image, so its regions are extracted from the cached image by
  `src/regions.ts` (changed pixels within 8px form one region). The two merge distances differ: at
  the same 24px Argos's IoU is 0.68 on main and 0.57 on held-out, a tie with PixelSlash's, which is
  why the table also has the paired row below.
- **IoU.** Read the gap between the tools, not the absolute number: the box is the element's rect,
  so a tight change (an 8px icon glyph in a 16px box) scores low for any tool.
- **IoU, how.** Pixel IoU between the union of a tool's regions and the ground-truth box. A tool that
  finds the box but also paints elsewhere loses on the union. Reported as the mean over the real
  cases the tool flagged. The paired row is the same mean over the real cases *both* tools
  flagged: a tool that also catches a faint or tiny change the other misses (and so scores a low
  IoU on it) is not penalised for catching it.
- **Time.** PixelSlash: `diffPngs` in-process, including PNG decode and overlay encode. Argos:
  `diffImages` inside the container, without ssh, tar or container start, as measured when the
  cache entry was made.
- **Size mismatch.** PixelSlash diffs only the overlapping rectangle (invariant 1) and states both
  sizes in the report, and the verdict is `changed` whenever the sizes differ; Argos pads the smaller
  shot and counts the padding as changed. The `size` cases measure that difference. They also cost PixelSlash IoU: the overlap is identical, so there is no region (the gutter is not a measurement), where Argos's padded region lands on the added content.

The results file also lists every case, and `bench/results/<date>/disagreements.html` shows the
cases where the tools disagree, or flag the same change in different places, with both diff images.
