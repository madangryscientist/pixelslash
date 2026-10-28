# pixelslash

Visual review from the command line: capture Main and Branch (Playwright, or PNGs you already
have), pixel-diff them, and write a `report.html`. Optionally judge each shot against a design
system with a local vision model, or upload the shots to a PixelSlash server for review.

This is the CLI of [PixelSlash](https://github.com/madangryscientist/pixelslash). The full
reference for every command and flag is that repository's
[`docs/cli.md`](https://github.com/madangryscientist/pixelslash/blob/main/docs/cli.md).

## Install

```bash
npm i -D @hackcove/pixelslash
npx @hackcove/pixelslash install-browser   # once per machine, for URL capture
```

- **Bun is required.** The bundle runs on the Bun runtime (`#!/usr/bin/env bun`), not Node; install
  Bun first (`engines.bun` is `>=1.4.0`).
- **Playwright is a peer dependency.** npm installs `playwright` next to the package. It is a peer
  because the browser it launches is yours: `pixelslash install-browser` runs that same Playwright
  to install `chromium-headless-shell`, **once per machine**. Without it, URL capture fails; PNG
  mode needs no browser.

## Use

```bash
# two screenshots you already have
npx @hackcove/pixelslash --live-png main.png --local-png branch.png --out out

# two URLs that are already up
npx @hackcove/pixelslash --live https://example.com --local http://localhost:3000 --out out
```

Open `out/report.html`. The exit code is 0 unless new violations were found on Branch; 2 is a
usage error.

MIT. See the `LICENSE` file at the repository root.
