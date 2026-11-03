# Getting started

Install PixelSlash, compare two versions of a page, and read the report it writes. Everything here runs on your machine: nothing is uploaded unless you ask for it.

## Install

PixelSlash is a Bun CLI that ships on npm. It needs [Bun](https://bun.sh) on your `PATH`.

```
npm i -D @hackcove/pixelslash
npx pixelslash install-browser
```

`install-browser` fetches Playwright's `chromium-headless-shell` once. It is for comparing URLs; comparing PNGs needs no browser. The full install notes, including a checkout and the other browsers, are in [Install](cli.md#install).

## Compare two URLs

`--live` is Main and `--local` is Branch. Both must already be up: PixelSlash does not start a dev server.

```
npx pixelslash --live http://localhost:4101 --local http://localhost:4102 --out .pixelslash
```

It captures both pages once each has settled, diffs them, and prints where the report is:

```
pixelslash: 3710 changed pixels
report: file:///…/.pixelslash/report.html
timing: 1 shot, capture 0.7s, diff 0.0s, total 0.7s
```

The exit code is 0 for a pixel-only run, changed or not.

## Compare two PNGs

Already have screenshots? Hand them over and skip the browser:

```
npx pixelslash --live-png main.png --local-png branch.png --out .pixelslash --label "button colour"
```

`--label` is optional text that is kept in the run's manifest. Two PNGs with the same bytes are not decoded at all, and the run says so.

## Open the report

`--out` (default `.pixelslash`) holds `report.html`, which opens as a plain file in any browser. A changed shot shows:

- the changed-pixel count, the number of changed regions, and both shot sizes;
- Main, Branch and the Diff side by side, cropped to the changed region and scaled up;
- a `Full frame` fold with the whole shot, where the Diff has the region boxes drawn on it;
- the timings of the run.

A shot with nothing changed shows the full frame as it is. [The report](cli.md#the-report) lists everything on it, and the same folder keeps `main.png`, `branch.png`, `diff.png` and a `manifest.json`.

## Next

- Too noisy, or too strict? [Tune the diff](cli.md#tuning-the-diff) with a threshold, floors or an ignored area.
- Capture every page of your app the same way every time: [snapshot capture](cli.md#snapshot-capture-the-pinned-image), or [your own Playwright tests](cli.md#snapshots-from-your-own-playwright-tests).
- Keep the builds in one place: [upload to a server](cli.md#uploading-to-a-server), and [sign in and read builds](cli.md#signing-in-and-reading-builds).
- Make CI wait for a human's yes: [block CI on review](cli.md#block-ci-on-review).
- Set up a repo in one command: [`pixelslash init`](cli.md#start-a-repo-pixelslash-init).
