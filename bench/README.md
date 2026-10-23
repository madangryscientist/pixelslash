# bench: PixelSlash against Argos

A re-runnable benchmark of **what gets flagged** (ob 1477): the same labelled screenshot pairs go
through PixelSlash's diff and through Argos's image comparison, and both are scored the same way.
Argos is a benchmark rival, never a code source; it runs only through `ops/argos-bench/`.

```bash
bun run bench                      # PixelSlash + Argos (from the cache), writes bench/results/<date>.{md,json}
bun run bench -- --refresh-argos   # ask VM 101 about the pairs the cache lacks, then run as above
bun run bench -- --calibration     # plus Argos's own 19 calibration cases, streamed from the VM
bun run bench -- --no-argos        # PixelSlash alone, prints the tables, writes nothing
bun run bench -- --capture         # plus the capture stage: needs Docker, skipped with a message without it
bun run bench:check                # regression guard: PixelSlash against the last results file
bun run bench:perf                 # speed, before vs after on this machine (see "Speed"); on demand only
bun run bench:perf:check           # the same comparison; exits 1 when a step is over 25% slower
bunx nx run bench:corpus           # re-render the main corpus (needs chromium-headless-shell)
bun bench/src/generate.ts --set holdout   # re-render the held-out corpus
```

**No VM is needed to run the benchmark.** Argos's verdicts for every pair are in
`bench/argos-cache.json` (verdict, score, time and changed regions) and `bench/argos-cache/diffs/`
(its diff images). An entry is keyed by the pair's content hash, the Argos commit pinned in
`ops/argos-bench/Dockerfile` and the threshold, so a re-rendered or new pair is a miss, never a
stale hit. A miss fails `bun run bench` and names the cases. `--refresh-argos` fills the misses
and drops entries no case uses any more; that is the only time VM 101 is needed. It refuses to
mix versions: if the VM's image is not built from the pinned commit, it stops.

For `--refresh-argos` the VM must be up (`ssh root@192.168.0.20 'qm start 101'`, and
`qm shutdown 101` afterwards: it holds 2 GB on a tight host; `ops/argos-bench/runbook.md`). The
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

It times five steps, with the warm-up discarded, and reports the median and p95 in ms:

| Step | What is timed |
| --- | --- |
| `diff-phone`, `diff-desktop`, `diff-long` | `diffPngs` (decode, diff, region clustering) on a 390x844, a 1440x900 and a 1440x6000 pair |
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
   `--refresh-argos` asks VM 101; `--no-argos` scores PixelSlash alone and writes nothing.

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
