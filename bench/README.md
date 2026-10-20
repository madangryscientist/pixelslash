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

## The regression guard

`bun run bench:check` (an Nx target, `bench:check`; not part of the default gate yet) runs PixelSlash
on both corpora, reads the newest `bench/results/<date>.json`, and exits 1 when, on either corpus,
real changes caught fall, or noise or identical pairs flagged rise. Fractions are compared exactly
(a corpus that grew compares by rate). It prints every number before and after, and the cases whose
verdict moved. It needs no VM and no browser. Commit a new results file when a score moves on purpose;
that file becomes the baseline.

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

## How it is scored

- **Verdict.** PixelSlash: `changed` from `diffPngs` at its defaults (perceptual threshold, anti-aliased edges not counted, a size mismatch always changed). Argos: score above 0
  (`diffImages`, threshold 0.5). Nothing is tuned for the benchmark.
- **Results file.** `bench/results/<date>.md` for people, `<date>.json` for `bench:check`: both
  corpora, each tool, per-corpus counts and PixelSlash's verdict per case.
- **Regions.** Neither tool returns a region list, only a diff image. Both masks go through the
  same extractor (`src/regions.ts`): changed pixels within 8px of each other form one region.
- **IoU.** Read the gap between the tools, not the absolute number: the box is the element's rect,
  so a tight change (an 8px icon glyph in a 16px box) scores low for any tool.
- **IoU, how.** Pixel IoU between the union of a tool's regions and the ground-truth box. A tool that
  finds the box but also paints elsewhere loses on the union. Reported as the mean over the real
  cases the tool flagged.
- **Time.** PixelSlash: `diffPngs` in-process, including PNG decode and overlay encode. Argos:
  `diffImages` inside the container, without ssh, tar or container start, as measured when the
  cache entry was made.
- **Size mismatch.** PixelSlash diffs only the overlapping rectangle (invariant 1) and states both
  sizes in the report, and the verdict is `changed` whenever the sizes differ; Argos pads the smaller
  shot and counts the padding as changed. The `size` cases measure that difference.

The results file also lists every case, and `bench/results/<date>/disagreements.html` shows the
cases where the tools disagree, or flag the same change in different places, with both diff images.
