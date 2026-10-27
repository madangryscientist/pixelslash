# Changelog

All notable changes to the `@hackcove/pixelslash` npm package (`packages/cli`) are listed here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The version is `packages/cli/package.json`'s, and a
release is the tag `v<version>` (see `.github/workflows/release.yml`).

## [Unreleased]

## [0.1.0] - unreleased

The first version of the package: a single bundle (`dist/index.js`) with
`@pixelslash/engine` inlined, plus `diff.wasm`.

### Added

- The `pixelslash` bin: the compare run (URL pair, PNG pair, routes), `init`, `capture`, `compare`,
  `import`, `upload`, `check`, `dev`, `login`, `logout`, `whoami`, `builds`, `build`, `status`,
  `flakes`, `flake`, `project`, `mcp`, `install-browser` and `--version`. The README has each
  command's flags.
- `playwright` as a peer dependency; `pixelslash install-browser` installs its
  `chromium-headless-shell` once.
- Runs on Bun (`engines.bun >= 1.4.0`).
