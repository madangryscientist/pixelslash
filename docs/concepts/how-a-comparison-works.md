# How a comparison works

A comparison takes two images of the same page and answers one question: did something change that a person could see? This page follows one pair from the two images to the verdict. [How the diff works](../cli.md#how-the-diff-works) has the exact rules and numbers.

## Main and Branch

Every comparison has two sides.

- **Main** is the image you compare against: production, a preview of your main branch, or a PNG you kept.
- **Branch** is the image of your change.

On the command line, `--live` is Main and `--local` is Branch:

```
npx pixelslash --live http://localhost:4000/ --local http://localhost:4001/
```

Both URLs must already be up. PixelSlash does not start a server for this command.

## Comparing pixels

The diff goes through the two images pixel by pixel. A pixel counts as changed when two things are true:

- Its colour differs by more than a small tolerance, `--threshold`, which is 0.01 by default. The distance is perceptual, so it is closer to what an eye sees than to the raw numbers in the file.
- It is not an anti-aliased edge in either image. Text and curves blend into their background, and those blended pixels move about between renders.

The number of those pixels is `changedPixels`. It is the first thing a run prints:

```
pixelslash: 3091 changed pixels
report: file:///…/my-site/.pixelslash/report.html
timing: 1 shot, capture 0.6s, diff 0.0s, total 0.7s
```

## When the sizes differ

If the two images are not the same size, only the rectangle they share is compared. The report states both sizes, and nothing outside the shared rectangle is painted as changed, because nothing there was measured.

A size difference always counts as a change, even when the shared rectangle is identical. Here a page grew 40 pixels taller and the rest stayed the same:

```
pixelslash: 0 changed pixels
```

That run has 0 changed pixels and `"changed": true` in its manifest. The count covers the overlap. The verdict covers the whole comparison.

## Regions

One changed button should read as one thing, not as 3,091 separate pixels. So changed pixels are gathered into **regions**: boxes around pixels that sit near each other. Two groups closer than `--merge-distance` (24 pixels by default) become one region. A report lists them like this:

```
#1 40,149 90x38 · 3091 changed px · changed
```

That is the region's position, its size and how many pixels in it changed.

## Specks

A region smaller than `--min-region-area` (4 square pixels by default) is a **speck**. Specks are dropped from the list and only counted, because a lone pixel is rarely a change anyone meant.

## Noise

Some regions change everywhere by a small amount: a gradient rendered a little differently, or a soft shadow. PixelSlash calls that **noise** when the colour differences are small, fairly even and spread through the region. A flat element that moved is never noise.

A noise region stays in the report, drawn with a dashed grey box and labelled `noise`. It does not make the run `changed`.

## Sub-pixel shifts

Text that moves by a fraction of a pixel looks the same to a person but differs in many pixels. PixelSlash tests whether one sub-pixel shift explains the region. If it does, the region is a **shift**. It stays in the report in its own style and does not make the run `changed`.

A whole pixel of movement is not a shift. Neither is movement next to a neighbour that stayed in place. Both stay real changes.

## How a run becomes changed

Regions end up as one of three kinds: `change`, `noise` or `shift`. A run is `changed` in two cases:

1. The sizes differ.
2. At least one `change` region survives, and it clears any floors you set in [Thresholds](thresholds.md).

A `changed` run does not fail. A pixel-only run exits 0 whatever it found, and it is up to you, or to [the review flow](review-flow.md), to decide what happens next. [Exit codes](../help/exit-codes.md) has the rest.

## Next

- [How the diff works](../cli.md#how-the-diff-works): the exact rules for noise and shifts.
- [Thresholds](thresholds.md): make the comparison stricter or looser.
- [Reading a report](reading-a-report.md): what all of this looks like on the page.
