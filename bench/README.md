# bench: PixelSlash against Argos

A re-runnable benchmark of **what gets flagged** (ob 1477): the same labelled screenshot pairs go
through PixelSlash's diff and through Argos's image comparison, and both are scored the same way.
Argos is a benchmark rival, never a code source; it runs only through `ops/argos-bench/`.

```bash
bun run bench                      # PixelSlash + Argos, writes bench/results/<date>.md
bun run bench -- --calibration     # plus Argos's own 19 calibration cases, streamed from the VM
bun run bench -- --no-argos        # PixelSlash alone, no VM needed (writes no disagreement page)
bunx nx run bench:corpus           # re-render the corpus (needs chromium-headless-shell)
```

Argos must be up: VM 101 on pve (`ops/argos-bench/runbook.md`). The address and key come from
`ARGOS_BENCH_HOST` and `ARGOS_BENCH_KEY`, the same variables `ops/argos-bench/run-pairs.sh` reads.
The per-pair Argos time comes from the wrapper in `ops/argos-bench/argos-diff.ts`, which is baked into
the image: after pulling a change to it, rebuild the image (runbook step 3) or the time reads `n/a`.
`--calibration` adds Argos's own 19 cases as a second section; their images are streamed from the VM
for the run and never stored in this repo.

## The corpus

`bench/corpus/<case>/{base.png,head.png,label.json}`, committed. `src/cases.ts` defines every case
and `src/generate.ts` renders them with Playwright's Chromium from the pages in `bench/fixtures/`
(plus `fixtures/pages`), so they can be regenerated; the benchmark itself reads the committed PNGs
and needs no browser. Fonts and anti-aliasing come from the machine that rendered them, so a
re-render on another machine gives a different corpus, not a different benchmark. Even on one
machine a re-render can move a few pixels in a case or two (Chromium repaints inputs on tile
threads), which is why the PNGs are committed and the benchmark never re-renders them.

| label | meaning | how the cases are made |
| --- | --- | --- |
| `identical` | the same page rendered twice | no change |
| `noise` | a difference nobody should be asked to review | font hinting and LCD anti-aliasing (a fontconfig file per side), glyph positioning, sub-pixel layout shift, a caret, a paused animation at another frame, +-1/2 channel drift on some pixels, JPEG round-trip |
| `real` | a change somebody should see | 1px spacing, colour shifts from large to barely visible, text change, missing element, icon swap, layout reflow, the page growing taller |

A `real` case carries a ground-truth box: the union of the rects of the elements it touches, taken
from the DOM in both renders. The caret is a 1px bar, because headless Chromium does not paint the
real one.

## How it is scored

- **Verdict.** PixelSlash: any differing pixel (`diffPngs`, today's engine). Argos: score above 0
  (`diffImages`, threshold 0.5). Nothing is tuned for the benchmark.
- **Regions.** Neither tool returns a region list, only a diff image. Both masks go through the
  same extractor (`src/regions.ts`): changed pixels within 8px of each other form one region.
- **IoU.** Read the gap between the tools, not the absolute number: the box is the element's rect,
  so a tight change (an 8px icon glyph in a 16px box) scores low for any tool.
- **IoU, how.** Pixel IoU between the union of a tool's regions and the ground-truth box. A tool that
  finds the box but also paints elsewhere loses on the union. Reported as the mean over the real
  cases the tool flagged.
- **Time.** PixelSlash: `diffPngs` in-process, including PNG decode and overlay encode. Argos:
  `diffImages` inside the container, without ssh, tar or container start.
- **Size mismatch.** PixelSlash diffs only the overlapping rectangle (invariant 1) and states both
  sizes in the report; Argos pads the smaller shot and counts the padding as changed. The `size`
  cases measure that difference, and the results say how many PixelSlash misses are of that kind.

The results file also lists every case, and `bench/results/<date>/disagreements.html` shows the
cases where the tools disagree, or flag the same change in different places, with both diff images.
