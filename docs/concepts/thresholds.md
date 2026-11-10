# Thresholds

Three settings decide how much difference counts. One works on each pixel and two work on the run as a whole.

| Setting | Flag | Config key | Default | What it does |
| --- | --- | --- | --- | --- |
| Threshold | `--threshold` | `threshold` | 0.01 | How far a pixel's colour must move to count as changed |
| Pixel floor | `--min-changed-pixels` | `minChangedPixels` | 0 | How many changed pixels a run needs to be `changed` |
| Ratio floor | `--min-changed-ratio` | `minChangedRatio` | 0 | What share of the compared area those pixels must cover |

Start with the defaults. Change a setting when you have a shot that shows you why.

## The threshold works on each pixel

`--threshold` runs from 0 to 1. Raising it means a pixel needs a bigger colour change to count. A subtle tint can drop out completely, and it then appears nowhere: no count, no region.

## The floors work on the run

The floors do not change what is measured. The diff finds the same pixels and the report still lists them. A floor only decides whether they are enough to make the run `changed`.

They count only the pixels of `change` regions. Noise, shifts and specks never count towards a floor.

## How the floors combine

A run is `changed` when the sizes differ, or when both of these hold:

- the pixels of its `change` regions reach `--min-changed-pixels`
- their share of the compared area reaches `--min-changed-ratio`

Both floors must be met. A floor can't excuse a difference in size, because that is always a change.

## A worked example

Two 400 by 100 images, so 40,000 pixels are compared. On Branch:

- a large blue box, 120 by 40, shifts to a very slightly different blue
- a small 6 by 6 square turns from near-black to red

```
npx pixelslash --live-png main.png --local-png branch.png
```

```
pixelslash: 4836 changed pixels
```

That is 4,800 pixels for the box and 36 for the square, in two regions. Now the same pair with different settings:

| Flags | Changed pixels | Regions | `changed` |
| --- | --- | --- | --- |
| none | 4836 | 2 | true |
| `--threshold 0.2` | 36 | 1 | true |
| `--threshold 0.2 --min-changed-pixels 50` | 36 | 1 | false |
| `--min-changed-pixels 50` | 4836 | 2 | true |
| `--min-changed-pixels 50 --min-changed-ratio 0.2` | 4836 | 2 | false |

Reading it row by row:

- **`--threshold 0.2`** lets go of the tint. The box is no longer measured at all. The red square moved much further in colour, so it stays.
- **Adding `--min-changed-pixels 50`** leaves the 36 pixels listed and says they are not enough. The red square is a real difference, so a floor set this high can hide a real change.
- **`--min-changed-pixels 50` alone** is met by 4,836 pixels, so nothing changes.
- **Adding `--min-changed-ratio 0.2`** asks for 20% of the image. The 4,836 pixels are 12.09% of 40,000, so the run is not `changed` even though the pixel floor is met.

The line on stdout is the count, not the verdict. All five runs exit 0, and the third prints this:

```
npx pixelslash --live-png main.png --local-png branch.png --threshold 0.2 --min-changed-pixels 50
```

```
pixelslash: 36 changed pixels
report: file:///…/report.html
timing: 1 shot, diff 0.0s, total 0.0s
```

The verdict is in `changed` in `manifest.json` and at the top of the report, which also shows the settings you used:

```
36 changed pixels
Diff options: threshold 0.2 · min changed pixels 50
Not changed: 36 changed pixels are under the floors above.
```

The report always says when a tolerance was in play, so a quiet result can't hide that someone loosened the check.

## In the config

For a whole project, set `diff` in `pixelslash.config.ts`, and override it for one route or one variant. The most specific level wins, key by key:

```json
{
  "diff": { "threshold": 0.02 },
  "routes": [
    { "path": "/pricing", "name": "pricing", "diff": { "threshold": 0.05 } },
    {
      "path": "/dashboard",
      "variants": { "mobile-dark": { "diff": { "minChangedPixels": 50 } } }
    }
  ]
}
```

The config lives in your repo, so a tolerance gets reviewed and versioned like any other code.

## Out of range

A value that is not a number from 0 to 1 stops the run with exit 2:

```
--threshold must be a number from 0 to 1
```

## Next

- [Tuning the diff](../cli.md#tuning-the-diff): every flag, including the noise and shift settings.
- [Ignore or redact](ignore-or-redact.md): for a part of the page, leave it out instead of loosening the whole shot.
- [Making shots stable](flaky-shots.md): a shot that changes by itself needs a fix, not a higher threshold.
