# PixelSlash facts

Checked against main at 4120ff6 on 2026-11-18.

## What it is
PixelSlash shows what changed on a web page between two versions of it, Main and Branch, as a report you open in a browser, and can send those screenshots to a review app where a person accepts or rejects each change. It is in alpha, and the command line tool is at version 0.7.

## Today
- `compare-two-pngs`: compares two PNG screenshots, Main and Branch, and writes a `report.html` that shows what changed; this needs no browser.
- `compare-two-urls`: shoots two URLs that are already running, with Playwright's Chromium headless shell, and compares them; it does not start a dev server.
- `waits-for-page-to-settle`: before each shot it waits for fonts, images, the network, two animation frames and an idle main thread, and fails at a timeout rather than shooting early or hanging.
- `perceptual-diff`: tells anti-aliasing, faint noise and sub-pixel shifts apart from a real change, and reports changed regions, not only a pixel count.
- `size-change-overlap-only`: when the two shots differ in size, it diffs only the overlapping area and states both sizes.
- `many-pages`: compares a list of paths in one run (`--routes`), and compares two folders of snapshots (`compare`).
- `pinned-capture-image`: `pixelslash capture` shoots every route in a config inside a pinned container image and records what rendered each shot.
- `storybook-stories`: shoots every story of a running Storybook 7 or later from its index, with no route list.
- `browser-choice`: a capture config can name Chromium, Firefox or WebKit; only Chromium is tested in a real browser.
- `playwright-helper`: `@hackcove/pixelslash-playwright` takes snapshots from your own Playwright tests, in Chromium only.
- `native-screenshots`: takes Android and iOS screenshots (from Maestro or any tool that writes PNGs) and pairs them with web shots of the same name and theme.
- `ignore-and-redact`: an area can be left out of the diff and still shown, or painted over before the PNG is written.
- `design-system-judge`: optionally checks each shot against your design system's component images with a local vision model (mlx or ollama); with no judge installed it prints `skip: no judge` and reports no violations.
- `accessibility-checks`: optionally runs axe-core on each page and lists the WCAG A and AA violations that are new on Branch; this never changes the exit code.
- `flaky-shot-detection`: re-shoots each changed shot and flags it as flaky when the shots disagree; `pixelslash flake` reproduces one locally and names the cause.
- `dev-mode`: `pixelslash dev` re-shoots a page or component on every save and compares it with the previous one, uploading nothing.
- `mcp-server`: `pixelslash mcp` is an MCP server, so a coding agent can read builds and changed shots and accept or reject a change.
- `init`: `pixelslash init` writes a `pixelslash.config.ts` from a few questions.
- `exit-codes`: exit codes are a fixed contract for CI ([the table](docs/cli.md#exit-codes-and-the-failed-line)): a compare run exits 0 when it finishes, whatever changed in pixels, 1 on new design-system violations on Branch or when the run failed, 2 on a usage error and 7 on a crash, never 1.
- `local-unless-upload`: screenshots leave the machine only through `pixelslash upload` or `--upload`, and then only to the server you name.
- `upload-to-review-app`: `pixelslash upload` sends shots to a PixelSlash review app, which diffs them against the default branch and holds the build for a person to accept or reject each change.
- `review-app-keyboard`: in the review app, `j` and `k` move through a build, `a` accepts and `r` rejects.
- `github-status-and-comment`: the review app posts a commit status on GitHub and keeps one comment per pull request; it does not react to anything on GitHub.
- `block-ci-on-review`: `pixelslash status --wait` makes a CI job wait until a person has decided.
- `subprojects`: one project can hold subprojects (end-to-end shots, stories) with their own builds and review, and one GitHub status for them all.
- `server-ai-explanations`: a project can name its own OpenAI-compatible model; the review app then sends it crops of the changed regions only, never a whole shot, to explain each change.
- `api-v1`: the review app has an HTTP API under `/api/v1`, which may still change while PixelSlash is in alpha.

## Planned
- `combined-subproject-review`: one review across all of a project's subprojects, instead of a page per subproject ([personas](docs/personas/README.md)).

## Licence
- `licence`: Elastic-2.0, source available under the Elastic License 2.0 (not open source).

## Where it runs
- `npm-cli`: the command line tool installs from npm as `@hackcove/pixelslash` and runs on Bun, not Node.
- `npm-playwright-helper`: the Playwright helper installs from npm as `@hackcove/pixelslash-playwright` and runs on Node.
- `capture-image`: the capture image is published as `ghcr.io/slashsuite/pixelslash-capture`, one tag per release.
- `from-source`: from a clone of the repository with Bun: `bun install`, then `bun run pixelslash`.
- `hosted-review-app`: the review app is hosted at app.pixelslash.dev, with sign-in by GitHub or Google.
- `self-host-cloudflare`: the review app runs on your own Cloudflare account (Workers, D1, R2), following `apps/web/SELF-HOST.md`.
- `self-host-docker`: the review app runs in Docker, one image and one volume with `docker compose up` in `docker/self-host/`, with no Cloudflare account.
- `docs-site`: the documentation is at pixelslash.dev/docs.
