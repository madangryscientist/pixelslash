# Changelog

All notable changes to the `@hackcove/pixelslash` npm package (`packages/cli`) are listed here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The version is `packages/cli/package.json`'s, and a
release is the tag `v<version>` (see `.github/workflows/release.yml`).

## [Unreleased]

## [0.1.1] - 2026-10-30

No change to the package. The first release published by `release.yml` through npm trusted
publishing, so it carries a provenance statement; 0.1.0 was published by hand without one.

## [0.1.0] - 2026-10-30

The first version of the package: a single bundle (`dist/index.js`) with
`@pixelslash/engine` inlined, plus `diff.wasm`.

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
