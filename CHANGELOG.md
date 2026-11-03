# Changelog

All notable changes to the `@hackcove/pixelslash` npm package (`packages/cli`) are listed here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The version is `packages/cli/package.json`'s, and a
release is the tag `v<version>` (see `.github/workflows/release.yml`).

## [Unreleased]

## [0.7.0] - 2026-11-03

### Added

- The side-by-side parity view (PS-298). One review page per snapshot key (name + theme) shows the web,
  Android and iOS shots next to each other at one physical size, with a column worded `no ios twin` for a
  missing platform. Under them, the PS-296 metrics mismatches as sentences, and a similarity score per
  native column that is a hint only: it changes no status, exit code, check or count. Reached from the
  side panel's Twins row ("Compare platforms"). `pixelslash mcp` exposes it as `get_parity_view`; the read
  is `GET /api/v1/builds/:id/parity?name&theme`. See "Parity view" in `docs/cli.md`.

## [0.6.0] - 2026-11-03

### Added

- Stale twins and the release check (PS-297). Accepting a changed web shot makes each native twin of that
  name and theme stale, until a reviewer accepts a native shot of it in a native build made after that
  change; an unchanged native shot carried forward does not clear it and is held for review with the reason
  `stale`. `pixelslash parity --release <platform> --project <id>` exits **8** while any twin on that platform
  is stale or its accepted baselines drift from web (with the same `--manifest`); `--json` lists each item's
  kind, key, platform and cause or mismatches. `pixelslash status` and `pixelslash mcp` show stale twins,
  and the build read's `twins` section marks them. See "Stale twins" in `docs/cli.md`.

## [0.5.0] - 2026-11-03

### Added

- `pixelslash parity --build <id>` (PS-296) compares the layout metrics of every twin pair in a build and
  exits **8** on drift. Lengths match within one physical pixel of the coarser side
  (`max(1/scale_a, 1/scale_b)` logical px); font size and weight must be equal; colours must be equal unless
  the web → native pair is allowlisted. A repo-kept `pixelslash.parity.json` (`--manifest`) holds that
  allowlist and per-platform deliberate differences; a declaration that no longer applies is printed, not
  failed. A pair without metrics on a side is `not measured`, never drift. Each drift is one sentence
  (`Button/md-primary dark: button gap 8 web vs 6 android`); `--json` and `pixelslash mcp` carry the full
  result. See "Parity" in `docs/metrics.md` and `docs/cli.md`.

## [0.4.0] - 2026-11-03

### Added

- Twin snapshots (PS-295). A web shot and a native shot with the same name and theme are twins; viewport
  and device are not part of the key, so every match is listed. Twins come from the same build, from a
  linked twin project's newest build at the same commit, or from the current baselines, and the source is
  named. `pixelslash build <id>` prints one line per unlinked shot (`Button/loading dark has no android
  twin`) and a count of linked ones; `--json` and `pixelslash mcp` carry the full `twins` section. A
  web-only build prints nothing new. See "Twins" in `docs/cli.md`.

## [0.3.0] - 2026-11-03

### Added

- Layout metrics files (PS-294). An optional `<name>.metrics.json` beside each snapshot records the box,
  padding, gap, font and colours of each named part, in logical px from the root part's top-left.
  `docs/metrics.md` (version 1) is the schema. `import` carries the file beside its PNG, a `metrics`
  config key (default off) makes `capture`, the Storybook path and `@hackcove/pixelslash-playwright`
  write it, and `upload` sends it. The snapshot read gives a signed `metrics_url`, and `pixelslash mcp`
  exposes the parsed file. Nothing compares it yet. Without a metrics file or the key, every manifest,
  stdout line and upload is as before.

### Fixed

- `capture` now honours a per-shot a11y `scan` from config. Its watch and timing wrappers had been
  dropping the argument.

## [0.2.0] - 2026-11-03

### Added

- Native screenshots (PS-293). `pixelslash import PNG_DIR --platform android|ios --device LABEL --scale N`
  files PNGs from an Android emulator or iOS Simulator (e.g. Maestro's `takeScreenshot`) as native
  snapshots. Platform and device are part of a snapshot's identity, so native shots never diff against
  web ones or against another device's. `upload` and `compare` accept them, and the device, platform and
  scale are in the fingerprint, so a new emulator image or device is a re-baseline. A web import (no
  `--platform`, or `--platform web`) and its manifest are exactly as before. `docs/cli.md` has the flags,
  the size rule and a Maestro determinism checklist.

### Changed

- The bundled engine is named `@hackcove/pixelslash-engine` (it was `@pixelslash/engine`). It is still
  inlined in the bundle and not published on its own, so nothing a user runs changes.

## [0.1.1] - 2026-10-30

No change to the package. The first release published by `release.yml` through npm trusted
publishing, so it carries a provenance statement; 0.1.0 was published by hand without one.

## [0.1.0] - 2026-10-30

The first version of the package: a single bundle (`dist/index.js`) with
`@hackcove/pixelslash-engine` inlined, plus `diff.wasm`.

### Added

- The `pixelslash` bin: the compare run (URL pair, PNG pair, routes), `init`, `capture`, `compare`,
  `import`, `upload`, `check`, `dev`, `login`, `logout`, `whoami`, `builds`, `build`, `status`,
  `flakes`, `flake`, `project`, `mcp`, `install-browser` and `--version`. `docs/cli.md` has each
  command's flags.
- `playwright` as a peer dependency; `pixelslash install-browser` installs its
  `chromium-headless-shell` once.
- Runs on Bun (`engines.bun >= 1.4.0`).
- Firefox and WebKit capture. A variant may name `browser: "firefox"` or `"webkit"` (default `chromium`, so
  existing configs and baselines are unchanged); the browser is part of a shot's identity, so a baseline is
  matched per browser. `--browser` picks the engine for `--live` / `--local`, and `install-browser` takes
  `chromium`, `firefox`, `webkit` or `all`.

### Fixed

- The capture image could not start (`Cannot find module '@pixelslash/engine'`): the CLI lists the
  engine as a devDependency, which the image's `--production` install skips. The Dockerfile now links it.
