# PixelSlash

Page vs design-system, vision-first — plus a pixel dashboard of Main vs Branch. Local mlx, else ollama, or opencode when you name a model. A standalone Bun CLI.

```
bun install
bun run pixelslash -- install-browser   # once, for URL capture (Playwright's chromium-headless-shell; `firefox`, `webkit` or `all` add the others)
bun run typecheck   # nx: tsc on every project
bun run lint        # nx: oxlint (type-aware) + check-slop
bun run format:check
bun run test        # nx: vitest on every project
bun run pixelslash -- <args below>
```

As an npm package (`@hackcove/pixelslash`, installed with `npm i -D @hackcove/pixelslash`; its command is `pixelslash`, from `packages/cli`; `bun run build:cli` builds it, `npm pack` packs it; not published yet), it needs Bun on `PATH` and takes `playwright` as a **peer dependency**: npm installs it beside the package, and `pixelslash install-browser` fetches Playwright's `chromium-headless-shell` once, for URL capture (`install-browser firefox`, `webkit` or `all` fetch the others, for `--browser`). PNG mode (`--live-png` / `--local-png`) needs no browser.

```
bun run pixelslash -- (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--browser chromium|firefox|webkit] [--label TEXT] [--threshold 0..1] [--min-changed-pixels N] [--min-changed-ratio 0..1] [--merge-distance PX] [--min-region-area PX] [--noise-amplitude 0..1] [--max-shift 0..1] [--ignore x,y,w,h]...
```

`--live` is **Main** (prod or a main preview). `--local` is **Branch** (this worktree's preview). Both URLs must already be up — the command does not start a dev server. Each capture waits for the page to settle before shooting: web fonts, every image, a short network-idle window, then two animation frames — all bounded by the capture timeout, so a page that never settles fails rather than hangs. Main and Branch are shot at once, each in its own page with its own settle. `--browser` (default `chromium`) picks the engine for both pages, so a pair is always shot in one browser; the report's sizes line names it (`firefox · Main 1280x720 · Branch 1280x720`). It applies to `--live` / `--local` only: with PNG inputs the pixels are already shot, and `--browser` there is exit 2. Firefox and WebKit need `pixelslash install-browser firefox` (or `webkit`, or `all`) once per machine; the capture image ships all three.

A URL pair may omit `--ds` and `--file`. PixelSlash captures both pages, pixel-diffs them, stores `main.png`, `branch.png`, `diff.png`, a manifest (`changedPixels`, `createdAt`, optional `--label`, `timings`), and `report.html`, and exits 0. stdout points at `report.html`. Same store as PNG mode. Identical shots still store a run (`changedPixels` 0). When the two PNGs are byte-equal nothing is decoded or diffed: there is no `diff.png`, the manifest carries `settledBy: "identical-bytes"`, and the report says "identical to baseline: same bytes, not diffed". Two PNGs with equal pixels but different bytes are diffed as usual. The diff is perceptual: a pixel counts toward `changedPixels` only when its colour differs by more than a small YIQ threshold (alpha blended over white) and it is not an anti-aliased edge in either shot, so `changedPixels` is smaller than a raw pixel-difference count. If width or height differs, only the overlapping rectangle is diffed: `changedPixels` is that overlap count, the report states both sizes, the non-overlap is not painted as changed, and the engine's verdict (`changed`) is true because the sizes differ. The changed pixels are then clustered into **regions** (`regions[]` in the manifest and the engine result): boxes with `x`, `y`, `w`, `h`, `changedPixels` and `antialiasedPixels`. Changed pixels and boxes closer than 24px are one region (`mergeDistance`); a box with an area under 4px (`minRegionArea`) is a speck, dropped and counted in `specks`; a region that is faint (90th percentile of colour distance at most 0.25, no pixel above 0.5), uneven (the spread of those distances is at least 0.3 of their mean, so a flat element that moved is never noise), and moves both lighter and darker (minority share at least 0.2), is labelled `noise`, kept in `regions`, and does not make the run `changed`. A region whose content moved by a fraction of a pixel, all alike (`maxShift`, 0 to 1; default 0.9), is labelled `shift`: the region's own box fits one sub-pixel shift on both axes, that fit explains at least a quarter of its colour difference, and the edge tiles in a 24px halo around the box agree with the same shift; a whole pixel moved, or a neighbour that stayed put, keeps it a `change`. `shift` regions are kept in `regions`, are drawn in their own style, and do not make the run `changed`. `changed` is true when the sizes differ or a `change` region survives. The numbers were chosen on `bench/corpus` (see `bench/README.md`). Default `--out` is `.pixelslash`.

`--threshold` (per-pixel tolerance, 0 to 1; engine default 0.01), `--min-changed-pixels` and `--min-changed-ratio` (floors on the run), `--merge-distance` (px; default 24), `--min-region-area` (px; default 4), `--noise-amplitude` (0 to 1; default 0.25) and `--max-shift` (pixels, 0 to 1; default 0.9; 0 turns the call off) tune the diff in every mode here. The floors combine with the region verdict, not beside it: they are measured on the pixels of the `change` regions that survive (noise and shift regions and specks never count), so a run is `changed` only when the sizes differ, or those surviving pixels are at least `--min-changed-pixels` and their share of the overlap is at least `--min-changed-ratio`. Out-of-range or non-numeric values exit 2. The counts are still reported when a floor says the shot is not changed. When the options differ from the engine defaults the report states them (`Diff options: threshold 0.2`, and `Not changed: … under the floors above` when a floor decided it) and the run's `manifest.json` records them as `diff`; with none set, the report says nothing and the manifest has no `diff`.

`--ignore x,y,w,h` (repeatable) is an area in image px that the diff skips: the pixels stay in both shots and the report draws a hatch over them, but nothing inside is counted, region-clustered or reported as changed. It is listed in the run's `ignored` and counted in `ignoredPixels`; the ratio floor's denominator is what was measured, so ignored pixels do not dilute it. Use it for a video, an ad, a map or live data — for secrets use a redact mask instead, which never reaches the PNG (see `masks` in the capture config). Pair mode only: it is refused with `--routes`.

`--live-png` / `--local-png` skip Playwright and use existing screenshots. `--ds` / `--file` may be omitted in this mode too: same pixel-diff store and `report.html`.

`--routes FILE` is one path per line (`/` `/pricing` …). `--live` and `--local` are origins. Without `--ds` or `--file`, each path is two captures, a pixel diff (`main.png`, `branch.png`, `diff.png`, manifest), and `report.html`. `--out/index.html` links those reports. Exit 0. With `--ds` or `--file`, each path is still two captures plus the DS judge. `--live-png-dir` / `--local-png-dir` is the GTK form (`index.png` for `/`, `pricing.png` for `/pricing`) and still needs `--ds` or `--file`.

With `--ds` or `--file`, one URL run captures both at the page width, then checks each shot against every DS component raster. Prefers `mlx_vlm.generate` when present (Mac). Else `ollama run qwen2.5vl` with the page shot, the DS raster, then the prompt (`ollama` on PATH; 100% local). PNG mode with `--ds` copies the given files into `--out` as `live.png` / `local.png` and runs the same judge. Reports violations already on Main vs NEW violations on Branch. Exit 1 if any NEW violations, else 0.

Install ollama and `ollama pull qwen2.5vl` (7b latest). Fallback if that does not fit: `ollama pull qwen2.5vl:3b && ollama cp qwen2.5vl:3b qwen2.5vl`. The CLI still spawns `qwen2.5vl`.

If both `mlx_vlm.generate` and `ollama` are missing, the HTML report still writes (shots + DS, no fake violations), stdout prints `skip: no judge`, and the process exits 0. DS-match judge is optional and is not required for screenshot pixel runs.

**The opencode judge (ob 1941).** Set `PIXELSLASH_OPENCODE_MODEL=<provider/model>` and every judge (the DS judge, `dev --judge`, `upload --judge`) runs `opencode run -m <model>` instead of mlx or ollama, with the shot and the DS raster as `--file`s. Unset, nothing changes: mlx, else ollama, else `skip: no judge`. No model is built in; the model is your choice, and it must read images. Check the terms of the plan behind it: OpenCode Go, for one, is for personal use only.

- **The key** is opencode's own: `OPENCODE_API_KEY` in the environment, or the `auth.json` opencode keeps under `~/.local/share/opencode/` (a mounted file in the capture image). PixelSlash never reads, logs or stores it, and the capture image does not contain one. Unlike mlx and ollama this is a hosted model, so the shot and the DS raster leave the machine for that provider: it is opt-in by the variable, and invariant 4 (`--upload`) is about PixelSlash's own server, not about this.
- **Tool-less.** A screenshot is untrusted input (text in it may say "run this command"), so the run is not allowed to call any tool. It never passes `--auto`, and it runs a private agent whose permissions deny every action (`{action:"*", resource:"*", effect:"deny"}`, injected through `OPENCODE_CONFIG_CONTENT`), in `--standalone` mode, from the shot's directory. `packages/engine/test/judge-opencode.test.ts` asserts the argv and the config; a prompt that asks that agent to run a shell command creates no file and emits no tool event, where the same prompt under `build --auto` does.
- **When it fails** the run names why and skips the judge, as `skip: no judge` does: `skip: judge binary missing`, `judge timeout` (300 s), `judge exit` (non-zero; stderr's tail is in the message) or `judge empty answer`. The report is still written, says nothing was judged and invents no violations; exit 0.
- The runner is exported from the engine as `askOpencode(prompt, images, { model })` for other callers.
- **In the capture image** `docker/capture/Dockerfile` installs opencode `2.1.4` (build arg `OPENCODE_VERSION`) from a tarball pinned by sha256, so `opencode` is on the PATH; pass the key at run time (`-e OPENCODE_API_KEY=…`) with `-e PIXELSLASH_OPENCODE_MODEL=…`. Capture does not use it,.

A one-pair run without a design system writes `--out/report.html` (open as `file://`): the changed-pixel count, the region and speck counts, both sizes, and Main, Branch and Diff. A changed shot (a `change` region survives) leads with those three **cropped to the changed region** — the union of the `change` regions plus 24px, clipped to the overlap of the two shots, scaled up with CSS so no extra file is written — and the full frame sits behind a `Full frame` click, where the Diff carries the region boxes (yellow for a change, dashed grey for noise). A shot with no `change` region keeps the full frame as is. With `--ds` or `--file`, that file is header counts, side-by-side Main/Branch shots, DS rasters, and the violation list. With `--routes`, open `--out/index.html`.

## Step timings

Every run that captures, diffs, judges or uploads records how long each step took, in whole milliseconds, and keeps it on the machine. A step the run did not do is absent, never `0`: a run with no judge has no `judgeMs`.

```json
{
  "totalMs": 11934,
  "captureMs": 8412,
  "diffMs": 1203,
  "judgeMs": 905,
  "browserLaunchMs": 41,
  "navigateMs": 180,
  "settleMs": 6120,
  "screenshotMs": 1890,
  "settle": { "fontsMs": 70, "imagesMs": 150, "networkIdleMs": 5730, "framesMs": 170 },
  "upload": { "totalMs": 2011, "batches": [{ "step": "open build", "count": 1, "ms": 140 }, { "step": "upload", "count": 12, "ms": 1790 }, { "step": "finalize", "count": 1, "ms": 81 }] },
  "shots": [{ "name": "pricing", "captureMs": 912, "navigateMs": 17, "settleMs": 690, "screenshotMs": 205, "settle": { "fontsMs": 7, "imagesMs": 12, "networkIdleMs": 650, "framesMs": 21 }, "diffMs": 130, "judgeMs": 210 }]
}
```

- `captureMs` is page load, settle and screenshot (absent for `--live-png`/`--local-png`, which only copy files); `diffMs` is the pixel diff and its regions; `judgeMs` the design-system judge (on `--upload`, the change-note model, counted even when its call fails). A shot taken in a browser splits `captureMs` into `navigateMs` (the page's load event), `settleMs` (the wait for fonts, images, network idle and two frames, split into `settle.fontsMs`, `imagesMs`, `networkIdleMs` and `framesMs`) and `screenshotMs` (the screenshot and its PNG); `browserLaunchMs` is the run's browser launch, once. Pages are shot at once (a pair's two, and up to four in `capture` and `check`), so a pair's parts add both pages and can exceed its `captureMs`, and a run's summed `captureMs` can exceed its `totalMs`. The shot count in the stderr line is the shots that were timed: `compare` leaves out shots only one side has. Each top-level step is the sum over the shots that did it, `shots` lists them slowest first, and `totalMs` is the command's wall clock (app start and browser launch included for `capture` and `check`).
- It is in the pair run's `manifest.json` as `timings` (a reader that does not know the field ignores it, and a manifest from before it reads as having none) and in its `report.html` as a **Timings** table, slowest shot first. `compare`'s `index.html` and `check`'s report index have the same table, and `capture --json` and `check --json` carry `timings`.
- Every one of these commands ends with one line on stderr, with the steps it did: `timing: 12 shots, capture 8.4s, diff 1.2s, upload 2.0s, total 11.9s`. stdout, including its first line, and the exit code are as they were.
- The snapshot dir's `manifest.json` (see [Snapshot capture](#snapshot-capture-the-pinned-image)) carries no timings: it has no timestamps, so two captures of the same build still write the same bytes.
- Timings leave the machine only with `--upload`, in the finalize body, to the server you named (`timings` there, [API](#api)). The server stores the steps it knows (`captureMs`, `diffMs`, `judgeMs`, `upload`) with the build, drops the capture parts and the launch, and ignores a body without timings; a malformed `timings` is dropped, not a 400. The finalize cannot include its own duration, so the server's copy is the figures up to the finalize; the stderr line and `upload.batches` on the machine count it. A batch's `ms` is the summed time of its requests, which run up to four at a time, so it can exceed the upload's `totalMs`.

### Server timings

The hosted app times its own steps on every build, in whole milliseconds, in the same D1 as the build and nowhere else (no outside telemetry). They are columns on the build, so the diff run and the explain queue each write theirs without reading the other's:

- `queueMs` (shown as "before diff"): the build's creation to the diff run's claim, so the CLI's uploads and any wait; the diff runs inside the finalize request, so there is no queue in it. Absent on a re-run (a resume after a stop, or a reviewer re-diffing a shot), whose build was created long before; the build is then marked `rerun`.
- `diffMs`: the diff, also when it ended in an error. `explainMs`: the queue's explanations, from the diff's end to the last shot settling. `summaryMs`: the build summary. A step the build did not run (no model, nothing to explain) is absent, never `0`.
- The end is `finishedAt`, moved by each AI step that finishes after the diff; the total is `finishedAt` minus the claim, so it is the build's whole server run. A new run clears the previous run's `explainMs` and `summaryMs`.

- Per shot, `snapshots.diff_ms`: how long the server took to compare that shot (both images read and diffed, the carried shot's compare included), written by the run that measured it. A resumed or re-run build rewrites only the shots it measured; a CI result, a new shot, a failed diff or a shot older than the column has none. On Workers the clock moves only at I/O, so the time runs to the compare's last read or write: an unchanged shot's diff after its last read is not in it.

The build page shows them under its header in a **This run** card, with the CLI's step timings when the upload carried them. The card adds the wall time (creation to `finishedAt`), the build's counts (shots, compares on the server or by CI, shots not measured, shots skipped as flaky, flake re-captures the CLI's evidence names, and on the default branch the shots auto-accepted), the per-compare time (median, 95th percentile or slowest, `n`, and the three slowest shots by name), and the model's tokens: in, out and total, from the endpoint's `usage` on each stored explanation and on the summary, with the calls they cover. A reply without `usage` counts as a call that did not report, never as an estimate, and a failed call stores nothing. Each figure says whether the server stored it, the CLI sent it, or it was derived; a build with none of them says so instead. The shot page shows the shot's compare time when it has one. The branch page states, over the branch's last 20 builds, the build count, the median and 95th percentile wall time, the total compares and the median compare time, each with its `n`, and a sparkline of wall time from three finished builds up. The org's **Timings** tab shows, per project, the median and 95th percentile of each step (nearest rank) over builds that finished in the last 30 days, newest 5000 at most; a smoke org has none, and a build that took a second run (`rerun`) is left out, since it holds the numbers of its last run only. Neither changes a verdict, a budget or the 25 s limit.

## Start a repo: `pixelslash init`

```
pixelslash init [--url URL | --storybook URL] [--routes /,/about] [--viewports 1280x720,375x812] [--themes light,dark] [--server URL] [--project NAME] [--yes] [--force]
```

- It writes `pixelslash.config.ts` from a few questions on stdin (a terminal or a pipe, one answer per line; an empty answer takes the default in brackets). Each flag answers its question instead; `--yes` takes the default for every question no flag answered and asks nothing.
- The app URL is probed for `<url>/index.json`: when it answers as a Storybook index, the config gets `storybook: { url }` and no routes are asked. `--storybook URL` says so without the probe. A URL that does not answer is just an app; nothing has to be running.
- The variants are every viewport × every theme. The project-wide `flaky: "review"` is written commented out, as the default it already is.
- The server is `--server`, else `PIXELSLASH_SERVER`, else asked (blank for none). When this machine holds a token for it (`pixelslash login`, or `PIXELSLASH_TOKEN`) the project is read from the server: the only one the token sees, or the one you name when it sees several. Not logged in, `upload.project` is left commented. **No token is ever written into the config.**
- It appends `pixelslash-snapshots/` and `.pixelslash/` to `.gitignore` when they are missing (a line with or without its slashes counts), so a second run changes nothing.
- It prints the next commands: `pixelslash check`, `pixelslash capture --upload`, and the CI steps from [Block CI on review](#block-ci-on-review).
- An existing `pixelslash.config.*` is kept and the run exits 2, unless `--force`. A bad answer (a URL that is not http(s), a route without a leading `/`, a viewport that is not `WxH`, a theme other than `light` or `dark`) exits 2 and writes nothing.

## Snapshot capture (the pinned image)

`pixelslash capture` shoots every route × variant in a config into a snapshot dir plus `manifest.json`, for upload to a PixelSlash server. Run it inside the pinned capture image: it fixes Bun, Playwright, Chromium, Firefox, WebKit and the font set, so the same commit renders the same pixels on any CI runner.

```
docker build -f docker/capture/Dockerfile -t pixelslash-capture:dev .
docker run --rm --network host -v "$PWD:/work" pixelslash-capture:dev capture [--config FILE] [--out DIR] [--only NAME]... [--json]
```

A release also publishes the image: pushing a `v*` tag builds it and pushes `ghcr.io/madangryscientist/pixelslash-capture:<version>` (`v0.1.0` becomes `0.1.0`; `linux/amd64`). Pull it in place of the local build, and pin by digest in CI. The licences of the bundled fonts (Liberation, DejaVu, Noto Color Emoji) are in the image under `/usr/share/doc/pixelslash-fonts/`.

`--config` defaults to the first `pixelslash.config.{ts,js,mjs,json}` in the working dir (JS/TS: the default export). `--out` defaults to `pixelslash-snapshots`. `--only NAME` (repeatable) captures just those routes or stories, every variant; an unknown name is exit 2. `--json` prints `{ measured: "local", uploaded: false, manifest, shots, timings }` instead of the summary, each shot with its `name`, `variant`, `browser`, `viewport`, `theme`, absolute `file` and `media` (see the media note under `ignore`); it is what the `capture_local` MCP tool returns. Exit 0 on success, 1 when a page cannot be captured or the start command fails, 2 on a bad flag or config.

```json
{
  "baseUrl": "http://127.0.0.1:4173",
  "start": { "command": "bun run preview", "readyUrl": "http://127.0.0.1:4173", "timeoutMs": 60000 },
  "setup": "./e2e/sign-in.ts",
  "routes": ["/", { "path": "/pricing", "name": "pricing", "masks": [".clock", { "x": 0, "y": 0, "width": 200, "height": 40 }], "ignore": [".live-chart"], "tags": ["billing"], "diff": { "threshold": 0.05 } }, { "path": "/dashboard", "variants": { "mobile-dark": { "diff": { "minChangedPixels": 50 } } } }],
  "variants": [
    { "name": "desktop", "viewport": { "width": 1280, "height": 720 } },
    { "name": "mobile-dark", "viewport": { "width": 390, "height": 844 }, "theme": "dark", "browser": "chromium" }
  ],
  "masks": ["[data-pixelslash-mask]"],
  "tags": ["web"],
  "diff": { "threshold": 0.02 },
  "stabilise": { "animations": true, "caret": true, "clock": "2026-01-01T00:00:00.000Z", "timers": true, "deviceScaleFactor": 1, "timeoutMs": 8000 }
}
```

- `baseUrl` must already be up, unless `start` is given: then the command runs first (in the container, from the working dir), its `readyUrl` (default `baseUrl`) must answer below 400 within `timeoutMs`, and the command's whole process group is stopped after the run. Its output goes to stderr. If `readyUrl` already answers before the command runs (another run on the same port), or the command has exited by the time it answers, the capture fails with exit 1 and writes nothing: the answer would be someone else's server.
- `setup` is the way in to pages behind sign-in: the path to a JS/TS module (relative to the config file) whose default export is an async function. It runs once, after `start` is ready and before the first shot, with `{ page, context, baseUrl }` (Playwright, in a fresh context whose `baseURL` is `baseUrl`, at the first variant's viewport and on the real clock). It runs in the first variant's browser; whatever it leaves in that context, cookies and local storage, is given to every shot, in whichever browser. The session is held in memory only: it is never written to the snapshot dir, the manifest or an upload. A setup that throws fails the capture with exit 1 and names the file; one that cannot be loaded or does not export a function is exit 2. Type it with `CaptureSetup` from `@pixelslash/engine`.

  ```ts
  // Sign in through the form. The password comes from env, never the config.
  export default async ({ page }) => {
    await page.goto("/login");
    await page.fill("#email", "visual@example.com");
    await page.fill("#password", process.env.APP_PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL("**/dashboard");
  };
  ```

  ```ts
  // Reuse a saved session: a Playwright storageState file kept outside git, named in env.
  export default async ({ context }) => {
    const { cookies } = JSON.parse(await Bun.file(process.env.APP_SESSION_FILE).text());
    await context.addCookies(cookies);
  };
  ```

  A setup can also seed data (it runs in the CLI's process, so it may spawn a seed script). `apps/web/e2e/dogfood-orgs.config.ts` is a worked example: it starts a local build of the review app, signs in through a GitHub stand-in and seeds fixed rows. There is no separate `storageState` option, because the second example above covers it in three lines.
- `routes` are paths or objects. `name` defaults to the path's slug (`/` is `index`; a query string is slugged too, so `/search?q=a&page=2` is `search-q-a-page-2`). Top-level `masks` and `tags` apply to every route. A route `path` may carry a query string; it is sent as written and recorded as-is in the manifest's `path`.
- `storybook` shoots a Storybook without a hand-written route list. Once the app is up (after `start`), capture reads `<url>/index.json` (Storybook 7+; `docs` entries are skipped, only `type: "story"`) and adds one route per story × each combination of the listed `globals` (no globals: one per story), each then × the config's `variants`. `url` is required; `baseUrl` defaults to it, so a Storybook-only config needs no `routes`. Example:

  ```json
  { "start": { "command": "bun e2e/serve.ts", "readyUrl": "http://127.0.0.1:6007" },
    "storybook": { "url": "http://127.0.0.1:6007", "globals": { "theme": ["default", "catppuccin-mocha", "thrifty-paper"] }, "include": ["**"] } }
  ```

  - Each story is shot at `/iframe.html?id=<id>&viewMode=story&globals=<k>:<v>;…`. Its snapshot `name` is `<title>-<story name>` lower-cased and slugged, plus `@<k>=<v>` per global in the order the config lists them (`ui-primitives-card-story@theme=thrifty-paper`). The name is built from the index entry alone, so it does not change between runs; the server keys a snapshot on it. A global's name or value may not contain `:` or `;`, and a value may not repeat.
  - A story that renders every global value itself (an all-themes overview) opts out of the product with the Storybook tag `pixelslash-once`: it is shot once, at the globals' defaults, as `<title>-<story name>` with no `@<k>=<v>`, and every other story is still shot per combination. The tag is read from `index.json` (a story's parameters are not in it), so it is explicit and nothing is de-duplicated by comparing pixels. Set it on the story (`tags: ["pixelslash-once"]`) or on a file's `meta`. Note that the story's snapshot name changes once, so its old per-theme baselines drop out.
  - A story sets its flaky policy (below) with the tag `pixelslash-flaky-skip` or `pixelslash-flaky-review`. Any other `pixelslash-flaky-…` tag, or both on one story, is a config error naming the story.
  - `include` (default `["**"]`) and `exclude` (default `[]`) are globs matched against the story id or its title; a story is shot when it matches `include` and not `exclude`. Nothing left after the filter is a config error, so a run that shoots nothing cannot pass.
  - Top-level `masks`, `tags` and `diff` apply to every story. `start.url` is not read; use `readyUrl` (it defaults to `baseUrl`, so to the Storybook's `url`).
  - Besides the usual settle, a story waits for Storybook's own signal (the preview shows `#storybook-root` with content), inside the same `timeoutMs`. A story that throws (Storybook's error display) or names no story fails the capture by name, and so does one that never renders.
  - Storybook routes and hand-written `routes` can be mixed; two that land on the same name are a config error naming both. It reads `index.json` over HTTP and never imports Storybook, so the project needs no Storybook dependency from us.
- `variants` default to one: Chromium, 1280×720, light. `theme` sets `prefers-color-scheme`. `browser` is `chromium` (the default, so a config that names none shoots as it always did), `firefox` or `webkit`; anything else is a config error. The browser is part of a shot's identity: a variant's default name carries it (`firefox-1280x720-light`), one page × three browsers is three shots, and each is diffed only against the baseline taken in its own browser, never across browsers (a shot whose browser has no baseline is new). Each browser is launched once per run, and each manifest entry's fingerprint names the browser that took it. The same settle applies in all three: a page that never settles fails in each, bounded by `timeoutMs`. Playwright's `launchOptions` (and the Chromium flags the image pins) apply to Chromium only.
- `masks` are **redact**: CSS selectors (every match) or rectangles in full-page CSS px (scaled by the device scale factor); both are painted `#FF00FF` before the PNG is written, so the content never leaves the machine. A selector that matches nothing prints a warning. Use it for secrets and personal data.
- `ignore` is the opposite: areas the diff skips while the real pixels stay in the PNG, so the report can hatch them over the shots. Same shapes as `masks` — CSS selectors (every match) or rectangles in full-page CSS px — and every element carrying `data-pixelslash-ignore` is one without a config entry. Selectors are resolved to boxes in the live page at screenshot time, in full-page coordinates, scaled by the device scale factor and clipped to the image; nothing is painted. A selector that matches nothing prints a warning. It is allowed at the same three levels as `diff` (top level, on a route, per variant on a route), but the layers **add up** rather than override: project + route + variant. Use it for videos, ads, maps and live data. Capture only records the boxes: the diff that skips them is the pair-mode CLI's, or the server's once uploaded.
- **Media is warned about, never fixed** (PS-230). Media renders unreliably: a spinner arc, a poster that arrives late. After the settle, capture measures every `<video>` and `<audio>` on the page (`getBoundingClientRect`, whole CSS px from the top of the document, grown outward so the box pastes into an `ignore` rect as it is) and warns once per shot and rect: `warning: <video> at 580,36 112x118 on overview (desktop) — media renders unreliably; add an exclusion zone (route.ignore) for this shot`. A story's route is not in the config, so its warning says to put `data-pixelslash-ignore` on the element in the story. A medium wholly inside an `ignore` area (a rect, a selector, a `data-pixelslash-ignore` element) is already excluded and does not warn; one only partly inside still does, with its whole box. The same boxes are each shot's `media` in `capture --json` and `check --json` (`[]` for none, otherwise `{ tag, x, y, width, height }`) so CI can act on them, and `pixelslash flake` offers the ignore rect for each as its first suggestion. Nothing is paused, seeked, frozen, masked or ignored for you; the PNG and every diff are as they were, and the manifest does not carry it, so it stays byte-reproducible.
- `diff` sets the diff tolerance a snapshot is compared with, as `{ threshold?, minChangedPixels?, minChangedRatio?, mergeDistance?, minRegionArea?, noiseAmplitude?, maxShift? }` (the same keys as the pair-mode flags; unknown keys, a threshold, ratio or amplitude outside 0 to 1, or a non-integer pixel count is a config error naming the key). It is allowed at three levels: top level (the project default), on a route, and per variant on a route as `variants: { "<variant name>": { "diff": {…} } }` (the name must be one of the config's `variants`). The most specific wins, key by key: variant > route > project > engine default. So the `/dashboard` route above compares `mobile-dark` with `minChangedPixels: 50` and `threshold: 0.02`, and every other variant of it with `threshold: 0.02` only. The resolved options are written to each manifest entry as `diff` and uploaded; a key nobody set is left out so the engine default still applies to it. The config lives in your repo, so a tolerance is reviewed and versioned with the code.
- `flaky` is the flaky policy, `"review"` (the default) or `"skip"`. It is set at the top level (the project default) or on a route; a route's own wins. Any other value is a config error naming its path (`routes[2].flaky must be "review" or "skip"`). The resolved policy is written to each manifest entry as `flaky` and sent with a shot found flaky on upload; what it does to the build is the server's call. See "Flaky shots" under "Uploading to a server".
- `flake: { "retries": N }` is how many more times `--upload` captures a shot that differs from its baseline (default 2; 0 turns it off). It must be a non-negative integer; `--flake-retries` overrides it.
- `a11y: true` scans every settled page for accessibility violations (PS-238; default `false`, and then nothing is scanned and nothing is claimed; any other value is a config error). See "Accessibility checks" below.
- `stabilise` defaults: animations and transitions off (finite ones jump to their end, infinite ones reset), caret hidden, `Date.now()` / `new Date()` frozen at `clock` (`false` for the real clock), page timers (`setInterval` / `setTimeout`) paused so carousels and tickers capture the same every time (`timers: false` lets them run; with `clock: false` they run too, and `timers: true` there is an error), device scale factor 1. Every capture also waits for the page to settle — fonts, images, network idle, two frames — bounded by `timeoutMs`; the settle cannot be turned off. Up to four shots are taken at once, each in its own browser context with its own settle, so the waits overlap and none is shortened; the PNGs and the manifest's order are the same as one at a time. Each shot keeps its own `timeoutMs`, and the four share the CPU: a page that only just settles in time when shot alone can run out of time here. With timers paused the settle never advances the page clock, so no timer fires during it either (a page that needs a delayed timer to render needs `timers: false`; Playwright's paused clock still runs zero-delay timers at load).

`manifest.json` (version 1) lists one entry per PNG; it has no timestamps, so two captures of the same build write the same bytes:

```json
{
  "version": 1,
  "snapshots": [
    {
      "name": "pricing",
      "path": "/pricing",
      "variant": { "name": "desktop", "browser": "chromium", "viewport": { "width": 1280, "height": 720 }, "theme": "light" },
      "tags": ["web", "billing"],
      "diff": { "threshold": 0.05 },
      "ignore": [{ "x": 40, "y": 40, "width": 400, "height": 200 }],
      "flaky": "review",
      "file": "pricing/desktop.png",
      "fingerprint": { "image": "version:0.1.0-dev", "browser": "chromium 148.0.7778.96", "fonts": "sha256:…" }
    }
  ]
}
```

The fingerprint says what rendered the snapshot; only snapshots with equal fingerprints are compared. `image` is `PIXELSLASH_IMAGE_DIGEST` when the run is given it (`-e PIXELSLASH_IMAGE_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' …)`), else `version:<image version>`. `fonts` hashes every font file fontconfig can see.

`diff` is the resolved diff options (`{}` when none are set; a manifest written before the field existed reads as `{}`), and `ignore` the resolved ignore boxes in image px (`[]` when none; a manifest written before the field existed reads as `[]`). Nothing in `ignore` is painted: the PNG holds the real pixels. `file` is relative to the manifest's directory and must stay inside it. See "Uploading to a server" for `--upload`.

Outside the image, `capture` still works but warns on stderr and records `image: "bare"`. Do not baseline from a bare machine: its own fonts and installs shift text and SVG rendering, and every snapshot will differ from the image's.

### Composition-only projects: what is styled outside the library

A project that builds its pages only from one design-system library's components can say so, and each capture then lists every element styled outside that library (ob 1850). It is a DOM measurement: no model is asked, nothing is judged, and exit codes do not change. A project without the key captures exactly as before.

```json
{
  "composition": {
    "library": "@hackcove/ui",
    "name": "Hack Cove UI",
    "custom": [{ "selector": ".hero-art", "reason": "the landing art is drawn by hand" }]
  }
}
```

- `library` is the npm package name; it must be installed in `node_modules` at or above the config's directory, or the capture stops before any shot (exit 2). `name` is what the lists call it (default: the package name). `custom` declares special cases by CSS selector, each with a reason; an unknown key, or an entry without both, is a config error naming it.
- The marker `data-pixelslash-custom="<reason>"` on an element does the same as a `custom` entry, from the page itself. A special case is listed with its reason and is never a gap; nothing inside it is walked.
- **What counts as the library's:** the class strings in the installed package's own JS (its string literals made only of class-like tokens; its dependencies' JS is not read). A class on an element is the library's when some whole library string is on that element. An element is a library element only when a whole string of two or more classes is on it: a one-class string (`"relative"`) covers that class but does not make an element the library's, since an app writes such classes by hand too. The inline style properties the library's JS sets itself (`style: { backgroundColor }`, `.style.x =`, `setProperty("x")`) are the library's on a library element.
- **What counts as custom**, per route and variant, walking the live page after it settles: an element with classes but none of the library's (`element`: a hand-rolled styled element), a library element with classes the library does not give added to it (`class`), and an inline style the library does not set (`style`). Hidden and zero-size elements are skipped, and so are `<html>` and `<body>` themselves (a style on them tints the whole shot); their children are walked.
- Each finding has the shot, a selector (a unique id, else `tag:nth-of-type` steps from `html`), the classes or style, and its box in image px. They are written to the shot's manifest entry as `composition: { library, gaps, special, omitted? }` (absent for any other project; a manifest written before the field existed reads the same as one without it) and uploaded with the shot. A shot keeps at most 500 findings (special cases first) and `omitted` counts the rest; the lists say how many were not kept. A selector, class, style or reason longer than 500 characters is cut to 500 with "…".
- The run writes `gaps.json` and `gaps.html` beside the manifest and prints `gaps: N styled outside the library, M special case(s): file://…`. Gaps are grouped across routes by what they add (the same stray class on five routes is one group), each group with a "not from <library>: …" line (the `reason` field of the group in `gaps.json`; only the DOM was read, so it says what is on the element, not what the library lacks) and a crop of each place (never scaled up more than six times); special cases are listed with their reasons. The list is a file: nothing was sent anywhere.
- On the server the snapshot page lists "<name> gaps on Branch" and "Special cases on Branch" full width under the shot and draws their boxes on the branch, on a new shot too (placed on the image's own size): gaps in amber, special cases dashed in violet, the same colours as `gaps.html`. The boxes have their own "Composition" toggle and a legend, hovering a box lights its row and the other way round, and the build page's shot card says how many gaps the shot has.
- **What the walk cannot see:** stylesheet rules that style an element by tag, id or attribute rather than class (a global `a { … }` is invisible); classes the library builds at run time from pieces (`` `text-${tone}` ``), which never appear whole in its JS and so read as the app's; any string in the library's JS that happens to look like classes (it counts as the library's); a library string that a class merger (`tailwind-merge`) or a conditional rewrote on the element, so no whole string is on it (its classes read as the app's); an app's inline style on a library element for a property any library component sets (the set is package-wide, not per component, so it passes); a library root whose only library string is one class (it reads as the app's), and a hand-built element whose classes are exactly one of the library's one-class strings (it passes); pseudo-elements, and anything drawn in a canvas, an iframe or a closed shadow root.

### Accessibility checks: violations that are new on Branch

`"a11y": true` in the config scans each page with [axe-core](https://github.com/dequelabs/axe-core) (MPL-2.0, used unmodified as an npm dependency) once the page has settled and the screenshot is taken, so the scan cannot change the PNG. Off by default: with it off nothing runs, the manifest has no `a11y`, and no report says anything about accessibility.

- It runs the WCAG 2.0, 2.1 and 2.2 level A and AA rules and keeps the violations only (not "incomplete" or "passed"). axe is evaluated through the browser's debugging protocol, so a page's Content-Security-Policy does not block it, and the page is not sent anywhere. A scan that fails or exceeds 20 s fails the shot like a capture error; it is never skipped silently. With `stabilise.timers` the page clock is let run again for the scan, after the screenshot.
- Each violation is `{ rule, impact, help, selector }`: axe's rule id, its impact (`minor`, `moderate`, `serious`, `critical` or null), the rule's one-line help and axe's path to the element (frames joined with ` >> `). They are written to the shot's manifest entry as `a11y: { violations, omitted? }` and uploaded with the shot. A shot keeps at most 200 violations and `omitted` counts the rest; a selector or help text longer than 500 characters is cut. A shot that was not scanned has no `a11y`, which is not the same as `{ "violations": [] }`.
- **New on Branch** is a violation (the same rule on the same selector) that is on Branch's scan and not on the baseline's. `compare` reads it from the two manifests: stdout gains `a11y: N new on Branch in M of K scanned shots` and up to 10 lines `  name (browser WxH): rule (impact) on selector: help`, then `a11y: N shots have no Main scan, so none of their violations is called new` when Main was not scanned, and a note when a scan kept only its first violations. `index.html` has an "Accessibility" section per shot with "New on Branch" and "Already on Main". A run where no shot was scanned prints nothing about it.
- **It never changes an exit code.** `compare` still exits 0 for a viewer and `check` still exits 1 only on new design-system violations; there is no flag that makes accessibility fail a run.
- On the server the snapshot page lists the shot's violations that are new against the baseline it was diffed against, with the ones already there folded below, and the build page's shot card gives the count. A baseline that was not scanned calls nothing new. The baseline is the shot's own (the branch's previous shot when there is one), so a violation introduced earlier on the branch reads as already there. The violations are stored per shot in `snapshots.a11y`, shown only, and decide no review state.

## Snapshots from your own Playwright tests

`@hackcove/pixelslash-playwright` (`packages/playwright`; packed with `bun scripts/pack-npm.ts`, not published yet) is for a team that already takes screenshots in its own Playwright suite and wants them reviewed without our capture image. `snapshot(page, name, opts)` shoots the page into a snapshot dir that `pixelslash upload` takes as it is, and measures the boxes to ignore at the moment of the shot: a PNG has no DOM, so "ignore this element" has to travel with it.

```ts
import { test } from "@playwright/test";
import { snapshot } from "@hackcove/pixelslash-playwright";

test("watch page", async ({ page }) => {
  await page.goto("/watch/42");
  await snapshot(page, "watch", { ignore: [".player", ".live-count"], redact: [".email"], tags: ["video"] });
});
```

```
npx playwright test
pixelslash upload pixelslash-snapshots --server URL
```

- Options: `ignore` and `redact` (selectors), `variant` (default `<width>x<height>-<theme>`), `tags`, `fullPage` (default `true`), `dir` (default `PIXELSLASH_SNAPSHOT_DIR`, else `pixelslash-snapshots` in the working dir) and `timeoutMs` (default 8000). It returns the manifest entry it wrote.
- Before the shot it waits for the same settle as `capture` (fonts, every image, network idle, two frames), bounded by `timeoutMs`; a page that never settles fails the test. The shot is taken with animations disabled and the caret hidden.
- `ignore` is measured as `capture` measures it: every match of every selector, plus every `[data-pixelslash-ignore]` element, as boxes in image px (scaled by the page's device pixel ratio, from the top of the document for a full-page shot and from the viewport otherwise, clipped to the image). The pixels stay in the PNG. A selector that matches nothing warns. `redact` is painted over in `#FF00FF` before the PNG is written, so what it covered never leaves the machine.
- Each call writes `<name>/<variant>.png` and adds its entry to `manifest.json` (version 1, the format in [Snapshot capture](#snapshot-capture-the-pinned-image)); a rerun of the same shot replaces its entry. Two variants with the same name, viewport and theme are the same shot to the server, so the second is refused: give them different names. Parallel workers share the dir: the manifest is written under a lock. The dir is not cleared, so remove it before a run, or a test you deleted still uploads its last shot.
- The browser must be a launched chromium with a fixed viewport; anything else throws. The theme is what the page reports for `prefers-color-scheme`.
- The fingerprint is `bare` outside our image (its digest inside it), the chromium version and the font-set hash. Only equal fingerprints are compared, so keep baselines and branches on the same machine image.
- What it cannot do from inside your test, and `capture` does: launch chromium with `--force-color-profile=srgb --font-render-hinting=none`, pin the clock and stop page timers, and fix the fonts. The flags go in your config's `launchOptions.args`; the fonts are the image's job. To pin the clock as `capture` does, before `goto`:

  ```ts
  import { keepNativeRaf } from "@hackcove/pixelslash-playwright";

  await page.addInitScript(keepNativeRaf); // the settle waits on real frames; a paused clock has none
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  ```

  Skip `keepNativeRaf` and a paused clock fails every `snapshot` on its settle. `page.clock.setFixedTime(time)` instead pins only `Date` and leaves timers running.
- It runs on plain Node (20 or newer) under `npx playwright test`: the shipped bundle has the few engine pieces it needs inlined and calls no Bun API (a test builds it and fails if one appears, and runs it under Node and Bun to check the ignore and redact boxes come out the same). `@playwright/test` (1.40 or newer) is its only peer. `pixelslash upload` is the CLI's, and the CLI is a Bun program, so Bun is needed on the machine that uploads, not on the one that runs the tests. `examples/playwright-node` is a project outside the workspace that installs the packed tarballs of both; `bun scripts/check-example.ts` runs it as CI does, with no `bun` on `PATH` for the test step, then uploads the dir it wrote to a stub server.

## Snapshots from PNGs you already have

`pixelslash import` turns a dir of PNGs from any screenshot tool (Cypress, a Playwright script, a native app) into a snapshot dir that `pixelslash upload` and `pixelslash compare` take, so the server does not have to be fed by `capture`.

```
pixelslash import PNG_DIR [--out DIR] [--viewport WxH] [--theme light|dark] [--renderer LABEL]
pixelslash upload DIR --server URL
```

- Every `.png` under `PNG_DIR`, at any depth, is one snapshot. Its **name** is its path under `PNG_DIR` without the extension, `/`-separated: `home.png` is `home`, `billing/invoice.png` is `billing/invoice`. Other files are ignored. A file that is not a PNG, an empty dir and two PNGs with the same name are exit 2 with nothing written.
- The PNGs are copied into `--out` (default `pixelslash-snapshots`, like `capture`) next to a version 1 `manifest.json`. An `--out` that is, holds or sits inside `PNG_DIR` is refused. stdout is `pixelslash: N snapshots` and `manifest: PATH`; exit 0.
- Nothing is read from the shots, so the identity half that a screenshot tool knows and we do not is yours to give. `--viewport` (default `1280x720`) and `--theme` (default `light`) apply to **every** PNG: a snapshot is identified by name + browser + viewport + theme, and the viewport is the setting the page was shot at, not the image size (a full-page shot's height changes with the page, and must not turn every change into a new and a removed snapshot). A dir with both themes is two imports into two dirs. The browser is `chromium`, the only value `upload` accepts.
- The fingerprint says the renderer is not ours: `{ "image": "external", "browser": LABEL, "fonts": "unknown" }`, where `--renderer` is the label (default `external`). Only snapshots with equal fingerprints are compared, so **change the label when you change the tool or its version**: the server then asks for a re-baseline instead of showing a wall of diffs that are the new renderer's. Keep the label stable otherwise.
- Each entry has the engine's default diff options, no ignore areas and no tags. `path` holds the file's path; it is not uploaded.

## Comparing two snapshot dirs

`pixelslash compare` is pair mode for two `capture` outputs: Main's snapshot dir against Branch's, on this machine, with no design system and no server.

```
pixelslash compare MAIN_DIR BRANCH_DIR [--out DIR]
```

- Each dir is a `manifest.json` and the PNGs it names, checked before anything is diffed. Entries are matched by **name + browser + viewport + theme**, the same identity a server uses (the manifest has no platform; the server's is always `linux`).
- Each matched pair goes through the engine's pair diff with the **Branch** entry's resolved `diff` options (what the server does: the new shot's options decide) and the **union** of both entries' `ignore` boxes (also the server's rule, so an element that moved is covered at its old and its new place). Note this is wider than "the Branch manifest's ignore boxes" alone.
- A snapshot only on Branch is **new**; one only on Main is **removed**; neither is diffed. A matched pair the diff calls not changed is **unchanged**.
- `--out/index.html` states the counts (`N changed · N unchanged · N new · N removed`) and links one `report.html` per **changed** snapshot, which sits in its own dir under `--out` with `main.png`, `branch.png` and `diff.png`. Unchanged snapshots get no files. Default `--out` is `pixelslash-compare`; it is not cleaned, so a re-run into the same dir leaves the old reports of snapshots that have since stopped changing. Use a fresh dir. An `--out` that is, holds or sits inside either snapshot dir is refused.
- If a pair's fingerprints differ (image, browser or fonts), `compare` warns on stderr by name and **still diffs**; the index says so at the top, since the pixels then mix a real change with a different renderer. A server would instead ask for a re-baseline.
- stdout is `pixelslash: N changed, N unchanged, N new, N removed` (unchanged byte for byte, so a script can parse it), then the names: a `changed:`, a `new:` and a `removed:` group, each name indented two spaces as `name (browser WxH)` (`prefers: dark` is added when the compare varied the scheme), at most 10 per group and then `  +N more`. A group with nothing in it is not printed, unchanged snapshots are never listed, and a run where nothing moved prints the counts line alone. Then `fingerprint: N differ (diffed anyway)` when any differ, then `report: file://…/index.html`. The top of `index.html` lists the same three groups uncapped, each name linking to its entry further down the page. Exit 0 whether or not anything changed: this is a viewer, not a gate. Exit 2 on a missing dir or manifest, a bad manifest or a file that is not a PNG, a missing argument, or an overlapping `--out`.
- **A shot the diff cannot measure is `not compared`, never unchanged** (PS-223). The run goes on: the counts line gains `, N not compared`, a `not compared: name (browser WxH): <error>` line names each shot, `index.html` lists them under "Not compared" with the error, and the other shots are reported as usual. Then, after the `report:` line, stderr gets the `FAILED` line (see [Exit codes](#exit-codes-and-the-failed-line)) and the exit is **7**. A file that is a PNG by its header but will not decode is such a shot.

## Feature mode: `pixelslash dev`

`pixelslash dev` is a fast local loop for one page or component while you build it: every save re-captures the target and diffs it with the previous iteration. Nothing is uploaded, and nothing is written to a server.

```
pixelslash dev [TARGET | --url URL] [--viewport WxH|NAME] [--theme light|dark] [--watch PATH]... [--against main] [--judge [--ds DIR]] [--refresh-refs] [--figma-token-path PATH] [--once] [--json] [--config FILE] [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH]
pixelslash dev latest [TARGET] [--json]
pixelslash dev pin [ID] [--json] · pixelslash dev unpin [ID] [--json]
pixelslash dev spec [TARGET] [--json] [--refresh-refs] [--viewport WxH|NAME] [--theme light|dark] [--figma-token-path PATH] [--config FILE]
```

- **Target.** `TARGET` is a route or story name in the config; `--url URL` shoots a bare page with the config's variants, or the defaults when there is no config. Every variant runs unless `--viewport` (a `WxH` or a variant name) or `--theme` narrows them. The app must already be up: `dev` ignores the config's `start`, and a URL that does not answer is exit 2 with `is not answering …; pixelslash dev does not start a dev server`.
- **Watching.** The git working tree, minus what git ignores and minus `.pixelslash/`, or only the paths given with `--watch` (repeatable or comma-separated). A burst of saves is debounced into one run; a save during a run queues exactly one more. Each run waits for the page to settle as `capture` does. A directory created after `dev` starts is not watched until the next start.
- **Speed.** The browser stays open between runs. Every run prints one line, with the page's settle time apart from ours:

  ```
  #3 vs #2: 3 regions changed · 412 px · ours 0.9 s · settle 1.4 s · http://127.0.0.1:PORT
  ```

- **Keys.** `r` run now · `p` pin the latest iteration · `u` unpin · `m` toggle main / previous · `f` refetch the Figma refs · `q` quit.
- **What a run is compared with.** By default the previous iteration; while an iteration is pinned, the newest pin. `--against main` (or `m`) compares with the baselines the server would pick for this checkout, through the same read-only `POST /api/v1/baselines` that `check` uses, as whoever `pixelslash login` or `PIXELSLASH_TOKEN` is. Without credentials it says `no credentials for main's baselines (…)` and stays on the previous iteration.
- **Judge.** `--judge --ds DIR` runs the design-system judge on each iteration after its diff is shown. On a target with a spec or refs (below), `--judge` also shows the local vision model the shot, the reference and the spec, and it lists how the shot differs, each with a box on the shot, numbered on the live page; `--ds` is then optional. The list is descriptions, never a pass, a fail or a score. With no judge available it prints `skip: no judge` and invents nothing.
- **Live page.** `http://127.0.0.1:PORT` (bound to loopback only) shows the shots, the diff, the comparison image, the timeline of iterations, the pins, the judge's notes and the feature section (below), and updates itself after each run. Its buttons send a header a page from another origin cannot, so another site cannot pin or run.
- **Storage.** Iterations and pins live in `.pixelslash/dev/` at the worktree root, which ignores itself (`dev` writes a `*` into `.pixelslash/dev/.gitignore`; your own `.gitignore` is not touched), and they survive a restart. The store is capped at 200 MB: past it the oldest iterations go first, never a pin, the newest, or what the newest was compared with.
- **One session per worktree.** A second `pixelslash dev` in the same worktree attaches to the first: it prints the live page and follows its runs, and `q` leaves it without stopping the session. `dev --once` on a different target than the session's is exit 2, rather than returning the other page's result. A lock whose process is gone is taken over.
- **Without the terminal.** `dev --once --json` runs one iteration and prints `{ uploaded: false, page, id, target, against, note, counts, regions, changedPixels, timings: { totalMs, settleMs, oursMs }, shots, judge, differences }`, where each shot names its PNG and diff files, and `differences` is the judge's list (`{ status, items: [{ n, name, shot, ref, area: { x, y, width, height }, what }] }`) when `--judge` ran on a feature; with a session live it asks that session to run (no second browser) and prints its iteration with the session's `page`. `dev latest [--json]` prints the latest iteration, and `dev pin|unpin [ID] [--json]` pin or unpin one (the latest by default), live session or not.
- Exit 0 on a run, changed or not, and whatever the judge listed. Exit 2 on a usage error or a down URL. Exit 1 when a `--once` run fails (the capture, or main's baselines not reachable), and from `latest`, `pin` or `unpin` when there is nothing to show or change. In the live loop a failed run is printed and the loop carries on.

### A feature's spec and references

A target can name what it is being built against: a markdown spec, and reference images, each a PNG in the repo or a Figma frame. They go in the config under `features`, keyed by the route or story name:

```json
{
  "features": {
    "cart": {
      "spec": "docs/cart.md",
      "refs": [
        "design/cart.png",
        { "src": "https://www.figma.com/design/KEY/Shop?node-id=12-34", "viewport": "mobile" },
        { "src": "design/cart-dark.png", "theme": "dark" }
      ]
    }
  }
}
```

- **`spec`** is a `.md` path, and **`refs`** is a list of `.png` paths or Figma frame URLs (with a `node-id`), either bare or as `{ src, viewport?, theme? }`. Paths are relative to the config file. A ref with `viewport` (a `WxH` or a variant name) or `theme` applies only to the shots of that variant; one without applies to every variant. A bad key, path or URL fails at load and names the key (`features.cart.refs[1].src …`), and a file that is not there also names the config it was read from. PixelSlash reads the spec and the PNGs and never writes them; the spec is read again on each run, so editing it shows at once.
- **Figma refs** are rendered through the Figma API at the variant's width times `deviceScaleFactor`, and cached in `.pixelslash/dev/refs/`. They are fetched once, then again only on `f` or `--refresh-refs`, never on a save. The token comes from `FIGMA_TOKEN` or `--figma-token-path PATH`, never from git. Without one, that ref prints `skip: no figma token (URL)` and everything else carries on; an earlier render in the cache still stands. A Figma ref is the only thing in feature mode that touches the network.
- **The live page** gets a Feature section: per shot, the reference and the current shot side by side; the two overlaid, with a slider that fades the reference over the shot (onion skin); and the spec text. Both sizes are stated, and when they differ the overlay is only the overlapping rectangle from the top left, and the page says so. With `--judge`, the differences are numbered boxes on the shot with a list beside it.
- **What it does not claim.** Nothing is measured against a reference: there is no match percentage, no score and no pass or fail, on the page, in the terminal or in the JSON. A mock-up is not a baseline, so the overlay is for looking and the judge's list is for reading. The pixel diff stays between iterations (or main), as above.
- **`dev spec [TARGET] [--json]`** prints the spec and the refs without a run. `--json` is `{ target, spec: { path, text }, refs: [{ index, kind, source, variant, viewport, theme, file, size, skip, image }] }`, where `image` is the ref inline as a `data:image/png;base64,…` URL, scaled down to at most 1024 px wide, so an agent can look at it without opening a file. `TARGET` may be left out when the config has one feature.
- The spec and the refs never leave the machine: nothing is uploaded, and the server never sees them.

## Signing in and reading builds

The remote commands talk to a server's [API](#api) as one token. They read; only `upload` sends page shots, and only `flake --resolve` changes anything else.

```
pixelslash login [--server URL] [--config FILE]
pixelslash logout [--server URL] [--config FILE]
pixelslash whoami [--server URL] [--token-path PATH] [--config FILE] [--json]
pixelslash builds [--branch NAME] [--limit N] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash build ID|latest [--branch NAME] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash status [--build ID | --commit SHA | --branch NAME] [--dir DIR] [--wait [--timeout 30m] [--interval 15s]] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash flakes [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash project create NAME [--org NAME] [--server URL] [--token-path PATH] [--config FILE] [--json]
pixelslash project list [--server URL] [--token-path PATH] [--config FILE] [--json]
pixelslash flake ID [--runs N] [--out DIR] [--write | --suggest] [--resolve [--note TEXT]] [--json] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE]
pixelslash mcp [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--base BRANCH] [--figma-token-path PATH]
pixelslash --version
pixelslash install-browser [chromium|firefox|webkit|all]
```

- `login` asks for a personal token (`psu_…`; it prints where to make one: Settings → API tokens on the server, `<server>/settings`). On a terminal the token is read with echo off; otherwise it is the first line of stdin (`pixelslash login --server URL < token-file`). It checks the token with `GET /api/v1/me`, then stores it. A CI token (`psci_…` or an org token `psorg_…`) is refused: CI passes its token by `PIXELSLASH_TOKEN` or `--token-path` instead. No token is ever printed.
- **The credential file** is `~/.config/pixelslash/credentials.json` (`$XDG_CONFIG_HOME/pixelslash/` when that is set), mode 0600 in a 0700 dir, one token per server: `{ "servers": { "https://ps.example": { "token": "psu_…" } } }`. `logout` removes the server's entry and does not revoke the token; revoke it on the settings page.
- `whoami` prints the server, where the token came from, and the user and their orgs (the orgs of the projects the token sees), `org token for ORG` with the projects it reaches, or `CI token for project …`. `--json` is `{ server, via, me, orgs }`, with `me` the `/api/v1/me` reply.
- `builds` lists the project's builds, newest first (`--limit` 1 to 100, the API's own default otherwise), as a table: id, branch, commit, status, the count to review, and when. `build ID` prints one build, its counts, its web link and its snapshots; `build latest` is the project's newest build (on `--branch`, if given). With `--json` both print the API's reply byte for byte, unchanged: pipe it to `jq`.
- `status` prints one build's link and where its review stands (`changes: 2 waiting · 1 accepted · 0 rejected`), then one `skipped flaky: <name> (WxH theme)` line per flaky shot the `skip` policy kept out of review, and exits by the outcome (the table below). The build is `--build ID`; else the newest at a commit `--commit SHA` starts; else the newest on `--branch NAME`; else the one `upload` recorded in `DIR/build.json` (`--dir`, default `pixelslash-snapshots`) for this same server and the checked-out commit; else the newest at the checked-out commit. `--commit` and the commit fallback look among the project's newest 100 builds; an older one is named with `--build`. Picking more than one is exit 2, and no build at the commit or on the branch is exit 3. `--json` prints the build read (`GET /api/v1/builds/:id`) as sent. See [Block CI on review](#block-ci-on-review) for `--wait`.
- `--version` prints `pixelslash <version>`, the version the User-Agent sends. `install-browser [chromium|firefox|webkit|all]` runs the Playwright that `capture` uses to install that browser (`chromium-headless-shell` by default; an unknown name is exit 2).

**Resolution order**, the same for every remote command, `upload` included:

1. **Token:** `--token-path` (a file), else `PIXELSLASH_TOKEN` (CI), else the credential `login` stored for the resolved server.
2. **Server:** `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config (`--config`, or a `pixelslash.config.*` in the working dir).
3. **Project** (`builds`, `build latest`, `flakes`, `flake`, `upload` with a personal token): `--project` (an id, or a name the token sees once), else `upload.project` in the config, else the only project the token sees. More than one and none named is exit 2, listing them.

**Exit codes.** They are a contract: CI reads them, and none changes meaning.

| Code | Meaning |
| --- | --- |
| 0 | ok. For `status`: every changed shot accepted, or nothing changed. |
| 1 | **Reserved for NEW design-system violations on Branch** (invariant 3); no remote command uses it, except `upload`'s exit 1 for a refused upload or a build the server `errored` (PS-228) and `project create`'s for a server that refuses it. |
| 2 | A usage error: a bad flag or duration, no server, not logged in, no project picked, more than one build picked. |
| 3 | **The server did not give what was asked**: a refused, expired or revoked token (401), an id the token cannot reach (404), a server error, or a server that cannot be reached. For `status`, also a build that `errored` and no build at the commit or branch. `install-browser` also exits 3 when the install fails. |
| 4 | `status`: a reviewer rejected a shot, so the build `failed`. |
| 5 | `status`: the build still waits, for processing or for review. Under `--wait`, still waiting at `--timeout`. |
| 6 | `flake`: the shot is still unstable here, some run differed from the first. Not 1: 1 stays reserved for new violations. |
| 7 | **An internal error: a bug in pixelslash**, never a problem with your page or your config. A crash in capture, compare, the report or upload, or a `compare` shot the diff could not measure. A runner that sees 7 must **escalate to the PixelSlash planner**, not retry and not read it as a visual result. |

### Exit codes and the `FAILED` line

A crash never exits 1. Any error `pixelslash` did not expect writes, to stderr and in this order:

```
pixelslash: FAILED <command>: <stage>: <message>
nothing was uploaded            (or: upload incomplete: <n>/<m> shots sent)
a runner seeing exit 7 must escalate to the PixelSlash planner: this is a bug in pixelslash
<the stack>
```

The first line is one plain line to grep for. `<stage>` is the command's step that was running (`capture`, `compare` or `upload`); `check` and `dev` have none, so the line has no stage. The second line says what reached the server: `nothing was uploaded` before the build opened, `upload incomplete: 2/5 shots sent` after some PNGs went, `the upload had finished: 5/5 shots sent` when the crash came after finalise. Then exit **7**.

`upload` is stricter about its own failures: when the server refuses or cannot be reached, the **last two lines** of stderr are the upload line and `UPLOAD FAILED: <reason>`, nothing prints a build link, and the exit stays as above (1 for a refusal, 3 for a server that did not give what was asked). A build the server could not measure (`errored` once finalise has given up resuming it) is an upload failure too (PS-228): the reason names the build and its page on that same line, and the exit is 1, never 0.

A shot the diff cannot decode is not a usage error either: `check` and `dev` used to exit 2 on it and now exit 7, since the PNG is one pixelslash wrote.

The client sends `User-Agent: pixelslash/<version>`.

### Error reporting (opt-in)

`pixelslash` reports its own crashes to Sentry **only when `PIXELSLASH_SENTRY_DSN` is set** in the
environment. Unset (the default) the Sentry SDK is never loaded and nothing goes over the network
for it. Set, it reports two things: a crash (the exit **7** path above) and an `UPLOAD FAILED`
path. It never reports exit 1 (new violations), a usage error or any other result of a page: those
are verdicts, not bugs.

| Variable | Meaning |
| --- | --- |
| `PIXELSLASH_SENTRY_DSN` | The Sentry DSN to report to. Unset: no reporting. |
| `PIXELSLASH_SENTRY_ENVIRONMENT` | The environment tag. Default `cli`; `ci` is a good value in CI. |

The release is the CLI's own version. A report is the error's message, its stack, the release and
the environment: request and response bodies, cookies, tokens (upload, Figma, model keys), URL
query strings and any image or blob data are removed before it leaves the machine, and no shot is
ever attached.

## Your coding agent: `pixelslash mcp`

`pixelslash mcp` is a stdio [MCP](https://modelcontextprotocol.io) server, so the coding agent you already run can read PixelSlash (which builds have changes, what changed in a shot, which shots are flaky, what reviewers flagged) and drive feature mode in the worktree it was started in ([below](#feature-mode-from-your-agent)). Add it to Claude Code with:

```
claude mcp add pixelslash -- pixelslash mcp
```

```
pixelslash mcp [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--base BRANCH] [--figma-token-path PATH]
```

It resolves the server, the token and the default project as every remote command does ([Resolution order](#signing-in-and-reading-builds)): run `pixelslash login` first, or give it `PIXELSLASH_TOKEN`. The server is resolved on each tool call, so a missing token or a server that is down is an error the agent reads in the tool's answer, not a server that fails to start. Each read tool is one `/api/v1` read, and its text is the API's reply as sent:

| Tool | Arguments | Reads |
| --- | --- | --- |
| `whoami` | — | `GET /api/v1/me`, with the server and where the token came from |
| `list_projects` | — | `GET /api/v1/projects` |
| `list_builds` | `project?`, `branch?`, `status?`, `limit?`, `cursor?` | `GET /api/v1/projects/:id/builds` |
| `get_build` | `build_id` | `GET /api/v1/builds/:id`: counts, and each snapshot's group, diff numbers, regions, review state, `carried_from` and `approved_earlier` |
| `get_snapshot` | `snapshot_id` | `GET /api/v1/snapshots/:id`, with image URLs but no pixels |
| `get_snapshot_images` | `snapshot_id`, `which?` (`head`, `baseline`, `diff`) | the snapshot's PNGs, as images |
| `list_flakes` | `project?` | `GET /api/v1/projects/:id/flakes` |
| `list_detection_flags` | `project?`, `limit?`, `cursor?` | `GET /api/v1/projects/:id/detection-flags` |

`project` is an id or a name; without it, `--project`, then `upload.project`, then the only project the token sees.

- **It only reads the server, with one exception.** There is no tool to accept or reject a shot, upload or manage tokens: a review decision is a person's, in the web app. `resolve_flake` ([below](#using-pixelslash-from-your-agent)) marks a flake resolved, and only after a stable run on this machine. The `dev_*` tools write only to the worktree's `.pixelslash/dev/`, and the fix-loop tools only to their `out` dirs.
- **`get_snapshot_images` hands page shots to whatever model your agent uses.** The PNGs are fetched from the configured server only when that tool is called, and go back to the agent, which sends them to its model wherever that model runs. No other read tool returns pixels; the `dev_*` tools return the local shots, diffs and refs the same way. An image URL that is not on the configured server is not fetched.
- Nothing is sent anywhere but the configured server. Stdout is the MCP channel; the server logs one line to stderr.

### Using PixelSlash from your agent

The server also runs the local fix loop: **read** what the server says changed or is flaky, **reproduce** it on this machine, **change** the code (or, for content that is meant to move, the config), **re-check**, and **resolve**. The app must already be up at the config's `baseUrl`; no tool starts a dev server beyond the config's own `start` command. Shots are taken in the worktree the server was started in and stay there. Each tool runs the same function as its CLI twin with `--json`, and its first text is that twin's JSON:

| Tool | Arguments | Twin |
| --- | --- | --- |
| `check_local` | `only?`, `base?`, `flake_retries?`, `out?` | [`pixelslash check --json`](#check-before-you-push): captures here, compares with the baselines the server would pick for this commit, and returns each shot's status and regions and the report's path. Nothing is uploaded |
| `capture_local` | `only`, `out?` | `pixelslash capture --only NAME --json`: one route or story (or the ones named), every variant; the JSON, then each PNG as an image |
| `check_flake` | `flake_id`, `runs?`, `out?` | [`pixelslash flake ID --json`](#fixing-a-flake-locally): stable or not, each run's regions, the suggested fixes and the report |
| `suggest_ignore` | `flake_id`, `runs?`, `out?` | `pixelslash flake ID --suggest --json`: the suggested config changes (an ignore area, a stabilise setting, `flaky: "skip"`) as edits, each with the exact line it sets. It writes nothing: the agent shows the edit and the user makes it |
| `resolve_flake` | `flake_id`, `runs?`, `out?`, `note?` | `pixelslash flake ID --resolve --json`: reproduces it and resolves it on the server only when every run was the same. An unstable run sends nothing and returns `resolved: false` |

`only` is a name or a list of names. The prompts teach an agent the loop:

- **`fix-flake`** (argument `flake_id?`): `list_flakes` to read it, `check_flake` to reproduce it, fix the page or `suggest_ignore` and show the user the edit, `check_flake` again until stable, then `resolve_flake` with a note on what fixed it.
- **`explain-build`** (argument `build_id?`): `get_build`, `get_snapshot` and `get_snapshot_images` to say what changed, `check_local` on the changed shots to reproduce them, fix, `check_local` again, then report what is fixed, what still differs and what the user should accept on the server.

- **Progress and cancelling.** A client that sends a progress token gets one `notifications/progress` per shot (`progress` of `total` runs). Cancelling a call stops it before its next shot; the shot already in the browser finishes, bounded by its timeout.
- **What an agent cannot do.** No tool accepts, rejects or uploads anything, or writes the config. Nothing is sent anywhere but the configured server: `check_local` reads baselines and their PNGs, the flake tools read the flake list, and only `resolve_flake` writes, as `pixelslash flake --resolve` does.

### Feature mode from your agent

The same server drives [`pixelslash dev`](#feature-mode-pixelslash-dev), so an agent can build a page toward its spec and references and look at each iteration itself. The session is the one of the worktree `pixelslash mcp` was started in. Each tool runs the same function as its `pixelslash dev … --json` twin, and its first text is that twin's JSON; shots, diffs and refs follow as images, scaled down to at most 1024 px wide.

| Tool | Arguments | Twin |
| --- | --- | --- |
| `dev_start` | `target?`, `url?`, `viewport?`, `theme?`, `against?` (`previous`, `main`), `judge?`, `ds?` | `pixelslash dev`: starts this worktree's session, or attaches to the one running, and returns `{ started, target, page, by }`. `page` is the live page, which shows every iteration the agent makes |
| `dev_run` | — | `dev --once --json` with a session live: one run through the session, then its iteration with each shot and diff |
| `dev_latest` | `target?` | `dev latest --json`: regions, counts, timings, file paths, the judge's `differences`, and the images, without shooting |
| `dev_pin`, `dev_unpin` | `id?` | `dev pin\|unpin --json` |
| `dev_spec` | `target?`, `viewport?`, `theme?`, `refresh_refs?` | `dev spec --json`, except that each ref's `image` names the image block that carries it (`"image 0"`) rather than holding a data URL |
| `dev_stop` | — | `q`: stops the session this server started. A session started in a terminal is left running, and `dev_stop` says to quit it there |

- **The loop.** The prompt `build-to-spec` (argument `target?`) walks it: read `dev_spec`, `dev_start`, edit, `dev_run` or `dev_latest`, repeat until the shot matches, then `dev_pin` and `dev_stop`. The tool descriptions tell the agent to check after every edit. A save re-runs the session as it does in a terminal, so `dev_latest` after a save shows that run.
- **The session lives as long as the server.** One the server started stops when the agent's client closes it; one started in a terminal is driven through its live page, as a second `pixelslash dev` would be. One session per worktree still holds: `dev_start` on a different target than the live session's is an error.
- **What an agent can change.** It can run and pin, and pins are local to the worktree. It cannot accept, reject or upload anything, and no tool writes a config. `--against main` reads main's baselines with the server's credentials, read-only; the server flags (`--config`, `--server`, `--token-path`, `--project`, `--base`, `--figma-token-path`) are the session's.
- The judge's `differences` are descriptions, never a pass or a score, as on the live page.

## Uploading to a server

Nothing leaves the machine unless you ask: `pixelslash upload` and `pixelslash capture --upload` are the only commands that send page shots, and they send them only to the server you name. The same CLI talks to the hosted app and to a self-hosted one.

```
pixelslash upload DIR [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH] [--branch NAME] [--pr N] [--brief FILE | --brief-text TEXT] [--config FILE] [--flake-retries N] [--judge] [--wait [--timeout 30m] [--interval 15s]]
pixelslash capture [--config FILE] [--out DIR] --upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--flake-retries N] [--judge]
```

- `DIR` is a snapshot dir: a `manifest.json` and the PNGs it names (what `capture` writes). The whole manifest and every PNG are checked before anything is sent, so a bad dir never opens a build on the server.
- The token is a per-project CI token (`psci_…`, issued in the project's settings). An org token (`psorg_…`, issued under Organizations → Tokens) reaches every project of its org; like a personal token it names the project, but it never defaults to "the only one": with neither `--project` nor `upload.project` it is exit 2, naming both. A personal token (`psu_…`, issued under Settings → API tokens, with an optional 30-day, 90-day or 1-year expiry) acts as its user and reaches every project of that user's orgs; with one, `upload` names the project it opens the build in, resolved as in [Signing in](#signing-in-and-reading-builds) (`--project`, `upload.project`, or the only one the token sees). It comes from the file `--token-path` names, else `PIXELSLASH_TOKEN`, else the one `pixelslash login` stored for the server. Never put it in git.
- The server is `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config (`"upload": { "server": "https://…", "baseBranch": "main", "project": "web" }`; `upload` finds a config without `--config` only if one sits in the working dir, and runs fine without one).
- From the local git checkout it sends the commit, the branch, the **merge-base** with the base branch (`--base`, else `upload.baseBranch`, else `main`; `origin/<base>` is tried first) and up to **200 ancestor SHAs of the merge-base** (its first-parent history, nearest first; `git rev-list --first-parent`), so a project that nx or turbo "affected" skipped for many commits on main still finds its last build there. Without the base branch in the checkout (a shallow clone) it warns and sends no merge-base, and only HEAD's 20 nearest parents: check out full history in CI (`fetch-depth: 0`). The branch is `--branch`, else `GITHUB_HEAD_REF` / `GITHUB_REF_NAME`, else the checked-out branch; a detached `HEAD` with none of those is a usage error. The PR number is `--pr`, else read from `GITHUB_REF` (`refs/pull/N/…`).
- **A brief.** `--brief FILE` or `--brief-text "…"` sends your own words on what the build means to change (a PR body, a ticket's acceptance) with the build; giving both is exit 2. It is trimmed and at most 4000 characters: a longer one, or a missing file, is exit 2 before anything is sent. The CLI reads it from the file or the flag only; nothing fetches a PR body, a commit message or a ticket. It is stored on the build (`builds.brief`), never in the manifest or the local report, and capture, `check` and `compare` do not read it. The build and branch pages show it as plain text, labelled as the uploader's words, and the build's AI summary reads it (below). It decides nothing: status, counts, exit codes and the review are the pixels' alone. `capture --upload` sends none.
- It opens a build, uploads each PNG, then finalises with the snapshot count and the run's [timings](#step-timings); the server diffs inside that request. Exit 0 on success. Exit 1 when the server refuses (wrong or revoked token, 4xx/5xx) or cannot be reached, and the last two stderr lines are then `nothing was uploaded` or `upload incomplete: <n>/<m> shots sent`, and `UPLOAD FAILED: <reason>`; the build is then left open on the server, unfinalised, and its snapshots are not counted. The message names the step (`open build`, `upload <snapshot>`, `finalize`) and the server's answer in one line. A request the API never answered (the connection failed, a 502/503/504, or a 5xx that is not the API's `{"error"}` JSON, such as `vite preview`'s proxy page) is tried again after 1, 2, 4, 8 and 15 s (30 s in all, six tries: a server restart is about 13 s), with a warning on stderr for each retry; an error the API itself answered is not retried. Every step is safe to repeat, and a repeated open at worst leaves an empty unfinalised build behind. A finalise whose answer is `processing` (a retry that met an earlier try's diff still running, or one the runtime killed) is exit 1: nothing has been measured yet. So is one whose answer is `errored` (`UPLOAD FAILED: build <id> errored on the server: <reason> (<build page>)`), after the CLI has finalised again while the server's unmeasured count kept falling. Exit 2 on a bad flag, a missing token or server, or a bad manifest. Re-running makes a new build.
- A finalised upload records its build in `DIR/build.json` (`{ "server", "build", "commit" }`), so `pixelslash status` in the same working dir, at the same commit, reads that build; a record from another commit is ignored. `upload --wait` is `upload` then `status --wait` on that build, and exits as `status` does (see [Block CI on review](#block-ci-on-review)); a failed upload exits as before, without waiting.

What the server stores per snapshot: `name`, `platform`, `browser`, `viewport` (`WxH`), `theme`, `tags`, the resolved diff options (`diff`, stored as JSON in `snapshots.diff_options`; a client that sends none stores `{}`), the ignore boxes (`ignore`, JSON in `snapshots.ignore`, image px; a client that sends none stores `[]`), the environment fingerprint, the judge's sentence when `--judge` wrote one (`changeNote`, in `snapshots.change_note`; see below), a composition-only project's findings (`composition`, JSON in `snapshots.composition`; a malformed one or more than 500 findings is a 400; see "Composition-only projects"), the accessibility scan when the config asked for one (`a11y`, JSON in `snapshots.a11y`; null is not scanned; a malformed one or more than 200 violations is a 400; see "Accessibility checks"), and the PNG under the org's prefix in the blob store (R2 on Cloudflare). The manifest's `path` and the variant's `name` are not uploaded: a snapshot is identified by name + browser + viewport + theme, so two manifest entries that differ only by variant name are refused. The manifest carries no platform; `upload` sends `linux`, which is what the pinned capture image is.

The endpoints `upload` calls (`POST /api/v1/builds`, `POST /api/v1/builds/:id/baselines`, `PUT /api/v1/builds/:id/snapshots`, `POST /api/v1/builds/:id/finalize`), with their bodies and replies, are in [API](#api).

**Where the diff runs (`ci` or `server`).** Each project has a diff location, set on its settings page:

- **`ci`**: the CLI measures each shot in the CI job, with the same engine the server has, and the server only checks and stores what it sent.
- **`server`**: the server measures every shot when the build is finalised (below).

A new project on the hosted app is `ci`. A new project on a self-hosted server is `server`, unless its `DEFAULT_DIFF_LOCATION` var says `ci`. Projects from before the setting existed are `server`.

Changing the setting applies to the next build. The settings page warns about this: a build measured on one side is not guaranteed to match one measured on the other (the engine version can differ). A build that is open while its project is switched errors at finalise. Run it again.

The CLI does not pick baselines. `upload` and `capture --upload` always ask the server for each shot's baseline (`POST /api/v1/builds/:id/baselines`): the same pick that finalise makes, with the rules below. The reply says where the project diffs.

- **A `server` project:** the CLI uploads the PNGs as before, and the server diffs them. There is no flag to choose the other side: the project decides. The server stores each upload's sha256 and size; a shot whose hash equals its baseline's is stored `unchanged` with no `diff.png` and without reading either image, and a shot or baseline with no stored hash (one uploaded before ob 1948) falls back to comparing the two files' bytes, which still skips the overlay. The shot page says "identical to baseline: same bytes, not diffed".
- **A `ci` project:** the CLI fetches each baseline image and diffs the shot against it, using the shot's own diff options and the ignore boxes of both shots. It sends `diff_result`, the status, the diff mask PNG and its engine version with the shot. When a baseline carries an open change and the shot differs from it, the CLI also measures the shot against the accepted shot, so the server has whichever result its pick needs.

Finalise in a `ci` project runs no diff. Each result is checked for shape and bounds against the shot's PNG header, without decoding a PNG, and its status must follow from its counts under the shot's thresholds. A shot whose result fails these checks is not measured on the server instead. Its `diff_error` names the reason, and the build ends `errored` naming every such shot. The failures are:

- no result;
- a result that is not a result;
- a **stale baseline**: the result was measured against a different shot than finalise picked, for example because another build landed in between.

Carries and the default branch's auto-accept work as on the server. A CLI from before this setting sends no results, so a `ci` project refuses it when the build is opened: `426 this project diffs in CI; upgrade the CLI`. A CLI talking to a server from before the setting skips the baselines request and uploads as before. Every snapshot records who measured it (`measured_by`: `ci` or `server`) and the engine version, and the snapshot page shows both.

**Thresholds set in the review UI (server projects).** A member of the project's org can set `threshold`, `minChangedPixels` and `minChangedRatio` from a snapshot's page, for the test (every variant of that snapshot name) or for the test in that one variant. The precedence is, key by key: UI variant > UI test > config (variant > route > project) > engine default. Saving re-diffs the open build's matching shots at once and updates the build status; every later build is measured with it. An empty field is unset, and clearing an override falls back to the config. The snapshot page shows each value's source (`set in the UI by @login on <date> (this test, this variant); config says 0.01`). Every change writes an audit row (who, when, before and after), shown on the project's settings page and, for its tests, on the build page. To keep nothing only in the UI, each override offers its config snippet, and the settings page exports them all as a `pixelslash.config.json` fragment: merge each route's `diff` and `variants` into the route of that name, and the `variants` it names into yours (it names a variant by the config's default name, `chromium-1280x720-light`). Uploaded instead of the overrides, the export gives the same verdicts, unless the config already sets the same key on that variant, which beats a route's value. A `ci` project refuses an override: its diff is the CLI's, measured with the config alone.

**Ignore boxes drawn in the review UI (server projects).** On a snapshot's page, `Draw ignore box`, drag over the shot, then ignore that area for the test (every variant of that snapshot name) or for the test in that one variant. The box is in image px, as the diff measures. It is added to the shot's uploaded `ignore` areas (the union, never a replacement), saving re-diffs the open build's matching shots at once and updates the build status, and every later build is measured with it. The shot shows every ignored area hatched and labelled with its source: `UI` for a drawn box, `config` for an uploaded area, `manifest` for one uploaded with a PNG import. When a changed region touches an ignored area's edge the page warns that content may have moved out of the ignored area. Each box records who drew it and when; the project's settings list the active boxes, clear one (the box stays in the trail with who cleared it) and include them in the overrides export, under `ignore` on the route or on its variant. Each box also offers its config snippet. The export is in image px while the config's rectangles are in CSS px: divide by the device scale factor when it is not 1. A `ci` project refuses a box. Redact masks are untouched: an ignore box only stops the diff counting the pixels, which stay in the stored PNG.

**Flaky shots.** Before it uploads, the CLI diffs each shot against the baseline the server picked, in a `server` project too. That local diff decides only which shots to capture again, and a `server` project is never sent it. Each shot that differs is captured again `--flake-retries` more times (else `flake.retries` in the config, else 2; 0 captures each shot once). The new captures use the same route, variant and stabilisation as the first, one shot at a time in one browser. An unchanged shot is never captured again.

- A shot is **flaky** when any later capture differs from the first under the shot's own diff options and ignore boxes. Flaky means the captures disagreed with each other. It says nothing about whether the change is wanted.
- When every capture agrees, the shot is a real change, and nothing else happens.
- A flaky shot uploads its first capture, as before. The later captures go with it as evidence (form parts `flake:<run>`, runs numbered from 2). `meta.flake` is `{ runs, differed, regions, engineVersion, policy }`: the number of captures, the runs that differed from run 1, the changed regions of each differing run, and the engine version. Every shot sends its resolved policy as `meta.flaky`; a shot that is not flaky sends no `flake` and no `flake:<run>` parts.
- The server stores the detection (ob 1724). Each project keeps one **flake** per shot key (name, platform, browser, viewport, theme), open or resolved, with the evidence of each build that detected it: the runs, the runs that differed, their regions and the re-captures. A second detection appends its evidence; a detection on a resolved flake reopens it. A reviewer can also mark a shot flaky by hand on the snapshot page (with an optional note): that opens the key's flake with no evidence. A malformed `meta.flake` or `meta.flaky` is dropped, never a 400, and a `flake:<run>` part that is missing, too big or not a PNG is left out of the evidence.
- A shot is **labelled flaky** when its upload carried a flake record, when its key has an open flake as it is uploaded, or when it was marked by hand. Resolving a flake leaves the shots already labelled as they were, as history.
- What a labelled shot does to its build is its own `meta.flaky` (else the record's `policy`, else `review`). The server keeps no policy of its own; change it in the config and it applies from the next build.
  - `review`: the shot is badged flaky and is reviewed like any change. It waits for a decision and blocks the build until someone decides.
  - `skip`: a change on the shot is "skipped: flaky". It does not count toward "to review" and does not block the build. It is not accepted either: it never becomes a baseline, so the next build is still measured against the old one. The build summary counts these shots on their own line. A reviewer may still accept or reject it by hand.
  - A labelled shot is never auto-accepted, under either policy, so on the default branch a `review` flaky change waits for a decision too.
- The build page, each card and the snapshot page badge a flaky shot and link to it in the project's **Flakes** list (open flakes first, with their evidence; resolve with a note, or reopen). The snapshot page shows the runs side by side, how many differed, the policy in effect, and the exact config line that sets the other policy (a route's `"flaky": "skip"` or a story's `pixelslash-flaky-skip` tag), to copy.
- `capture --upload` re-captures in the browser it already has open. `upload DIR` re-captures through the config it finds (`--config`, or a `pixelslash.config.*` in the working dir). Without a config it warns and does not re-capture.
- A shot captured with a different image, browser or font set than this machine's is not captured again, since its runs would differ for that alone. `upload DIR` checks the image and font set before it opens a browser. The same goes for a route that is no longer in the config. Either case is a warning, and the shot uploads as captured.
- Each flaky shot prints `flaky: <name> (WxH theme): N of M runs differed; policy P`. The run writes `report.html` into the snapshot dir, plus the later captures under `@flake/` (`@` is outside the name alphabet, so no route's dir collides with it). The report shows each flaky shot as "flaky: N of M runs differed", with its runs side by side, the regions where they differed and its policy, then the shots that changed in every run, then the changed shots that could not be captured again and why. With nothing changed it says how many shots were measured against a baseline. It is written whenever a re-capture was possible, and is local only; each upload and each capture first removes the dir's earlier `report.html` and `@flake/`, and a report that cannot be written is a warning.
- Exit codes do not change: a flaky shot is said and sent, and whether it blocks the build is the server's decision.

### Fixing a flake locally

`pixelslash flakes` lists the project's open flakes: id, name, browser, viewport, theme, how many builds detected it, and when it last moved. `--json` prints `GET /api/v1/projects/:id/flakes` as sent.

`pixelslash flake ID` reproduces one on this machine, so a fix can be tried and seen to hold before anyone says it does:

- It finds the flake in the project's list and captures its key **locally** `--runs` times (default 5, 2 to 50): the config's route or story of that name, under the variant with the flake's browser, viewport and theme, through the config's own capture path and stabilisation, one shot after another in one browser. `baseUrl` must already be up. No dev server is started, except the config's own `start` command, as `capture` runs it. A key the config has no route or variant for is exit 2.
- Each run is diffed against run 1 under the shot's own diff options and ignore areas. It prints each run's regions and what the engine calls them (`real change`, `sub-pixel shift`, `noise`, or `size change` when the page's size differs), then `stable: all N runs rendered the same` or `unstable: X of N-1 runs differed from run 1`. A run differs when the diff calls it changed: noise and shift regions are listed but do not on their own make a shot unstable.
- When unstable, it says what to change, most specific first: an ignore rect for each `<video>` or `<audio>` the shot holds (the element's own box, filled in; see the media note under `ignore`); a page size that moves; any stabilisation the config turned off (`animations`, `caret`, `clock`, `timers`); an ignore area around every region that changed, in CSS px, for the flake's variant of the route; and last, `flaky: "skip"` on the route. For a story the ignore area and the policy are said as `data-pixelslash-ignore` and the `pixelslash-flaky-skip` tag, to add by hand.
- `--write` lists the suggestions that are config changes, each as the exact line it would set (`routes[1].variants.small.ignore += {…}`), and asks on the terminal which one to write. Only the number typed is written; an empty answer, or no terminal, writes nothing. It edits a JSON config only (rewritten as 2-space JSON, after the edited config is validated again); a JS/TS config is left alone and the change is to make by hand.
- `--suggest` lists the same config changes, each with the exact line it would set, and writes nothing. It cannot be combined with `--write` or `--resolve` (exit 2).
- `--json` prints the run as JSON instead of the text: `{ flake, measured: "local", uploaded: false, stable, differed, area, media, runs, suggestions, report, resolved }`, where each run has its `regions`, `causes`, `file` and `overlay`, and `resolved` is `null` without `--resolve`. With `--suggest` it prints `{ flake, stable, config, editable, written: false, edits, report }`, each edit with its `text`, `edit` and the `set` line (`null` for a change to make by hand). It is what the MCP tools `check_flake`, `suggest_ignore` and `resolve_flake` return. `--write --json` is exit 2: `--write` asks on the terminal.
- `--resolve` marks the flake resolved on the server (`POST /api/v1/flakes/:id/resolve`, with `--note TEXT`, at most 200 characters) only when this run was stable; an unstable run prints `not resolved` and resolves nothing. Resolving needs a personal token: a CI token is refused (exit 3). `--note` without `--resolve` is exit 2.
- The runs (`runs/run<N>.png`), each differing run's overlay (`runs/diff<N>.png`) and `report.html` are written to `--out` (default `pixelslash-flake`), whose earlier `runs/` and report are removed first. Nothing is uploaded.
- Exit 0 stable, 6 unstable, 2 on a usage error, 3 when the server refuses or does not know the flake, 1 when the capture fails.

**What changed, in a sentence (`--judge`).** With `--judge`, the local vision model (the same `mlx_vlm.generate` or `ollama` as the DS judge) writes one plain sentence per changed shot, such as "The Save button moved below the form". It is shown the baseline's PNG, the branch's PNG and the boxes the diff measured, and is told to say only what changed, with no verdict and no score.

- To know which shots changed, the CLI diffs each shot against the baseline the server picked, in a `server` project too, as for flaky shots. A `server` project is still never sent that diff.
- The sentence goes up as `meta.changeNote` (one line, at most 300 characters; the server collapses whitespace, drops a trailing full stop, cuts it to 300 and drops anything that is not a string, never a 400). It is stored in `snapshots.change_note` and shown on the build page's card, labelled as the judge's, and in the branch page's change summary. An unchanged or new shot gets none.
- The images go only to the local model, which runs on this machine. Nothing is sent to any other model.
- The sentence decides nothing: not a review state, a threshold, a build's verdict or an exit code.
- With no local judge, the run prints `skip: no judge` and uploads without sentences. A model that fails on a shot is a warning on stderr (`judge: <shot>: <why>`), and that shot uploads without one.
- `--judge` on `capture` needs `--upload`.

**AI explanations on the server (the project's own or its org's model).** A project can name an OpenAI-compatible vision endpoint in its settings (**AI explanations**): a base URL, a model and an API key. An org can name one too, once, on the **AI model** tab of its settings (`/orgs`), with the same form and rules, so each project does not repeat the key. A project's own settings win; a project without any uses its org's; with neither, there is no model. The project's settings page says which applies ("Using the org's model (<model>)", "This project's model", or none), and **Use the org's model instead** clears the project's own back to the org's. Any member of the org can set or clear the org's model. DeepSeek is the documented example (`https://api.deepseek.com`, `deepseek-flash`), and any endpoint that answers `POST {base URL}/chat/completions` with image parts works.
OpenCode Go (`https://opencode.ai/inference/go/openai/v1`) works for a personal self-host with a Go model that takes images; a deployed service should use OpenCode Zen or the provider's own API, because Go is licensed for coding-agent traffic. Calls to `opencode.ai` carry an `x-opencode-session` header naming the build, which Go requires.

- After a branch build gets its verdict, each `change` region of each changed, undecided shot is sent to that model as three crops: the baseline, the new shot and the diff overlay, cut to the region's box plus 16 px on each side. Nothing else of the shot is sent: one call per region, at most 8 per shot, a shot's regions asked at once. Explaining runs off the finalise request, on a queue (`EXPLAIN`, queue `pixelslash-explain`; miniflare runs it on a self-host), one job per shot, so each call has the whole model timeout however much of the diff budget the run used (ob 1875). While a shot waits, the build and snapshot pages say `explaining…` and reload themselves. A job whose model fails is tried 3 times, then the shot keeps the failure (for example `the model answered 401`) and is reviewed as plain pixels; one still queued after 15 minutes reads `explaining stopped`. A failed call is logged once per shot (never with the key), so a wrong key or base URL can be found.
- The model answers with a label (`intended`, `unintended` or `noise`) and one sentence. Both are stored on the shot (`snapshots.ai_review`), shown in the snapshot page's side panel and on the region's box, and counted on the build page's card.
- **Noise is only labelled unless the project opts in.** With **Auto-pass noise** on, a shot whose every changed region the model labels `noise` is accepted with no reviewer; the build page lists it under **AI-filtered**, and a person can still open it and reject it. A shot with a region left unexplained is never auto-passed, and neither is a shot whose size changed: its regions cover only the overlap.
- With no model set, nothing is sent anywhere. A call that fails or answers in the wrong shape stores nothing for that region. A shot with no region explained shows `skip: no judge`, and the failure when there was one, and is reviewed as plain pixels; the build's verdict never waits on the model.
- **A summary of the build.** Once every shot is explained or has failed, the same model is asked once, text only, for a short summary of the whole build, shown at the top of the build page. It is given each changed, new and removed shot's name and variants, the changed px and region count, and the stored region explanations; never an image. It groups a change seen in several variants into one sentence and names the new and removed shots, and each sentence links to the shots it describes. The page states the unchanged and not-measured counts and the regions labelled likely noise itself, so a shot that was not compared is never called unchanged. The summary is stored on the build (`builds.ai_summary`) with the model and the time, is written again when a resumed or re-run diff finishes, and **Regenerate** asks again. With no model, or a failed or malformed answer, nothing is stored and the page says `skip: no judge`; a failed Regenerate keeps the summary already stored, since nothing was measured again. Like the explanations, the default branch's builds are not summarised. It changes no verdict, no review and no exit code.
- **The summary against the brief.** When the build carries a [brief](#uploading-to-a-server), the same one call gets it too, quoted line by line after the shots as untrusted data, and is asked for one more line: whether the changes match the brief, naming anything that changed which it does not explain and anything it describes that did not change. A brief over 4000 characters (only possible past the API, which refuses it) is cut to its first 4000 and the prompt says so. The page shows that sentence after the others, marked `Against the brief:`, and the model line says `read against the brief`. It is the model's read, not a check: nothing reads it. A build with a brief where nothing changed asks no model and says nothing changed, not that it matches. The brief goes to this call only; region explanations and the DS judge never see it. Without a brief the prompt and the summary are what they were before it.
- The key is stored for the project (or the org) on the server, sealed under `MODEL_KEY_SECRET`, and never shown again; the page shows only that one is set. Changing the base URL needs the key again, so a saved key is never sent to a new host. A model's error reply is never shown or logged with the key in it.
- A re-run whose result is the same keeps the explanation; one whose result moved is explained again. The default branch's builds are accepted on finalise and are not sent.

**The server diff has a ceiling.** It runs inline in the finalise request, on a Worker with a 30 s CPU limit and a 128 MB isolate (decided 2026-10-20; no Queue for beta). Measured at 1280×4000: a typical shot takes about 0.8 s, a shot where every pixel differs about 15 s. One whole-page change fits; several do not. When the diff stops itself before the limit, the build ends `errored` and `error` names the limit (`diff ceiling: measured N of M shots…`); no shot is downscaled or cropped to fit. The finalise reply still carries `200`, so read `status` and `error`. A build too big for one run is resumed: finalise again and the server keeps what it measured and diffs the rest under the same budget, so repeated runs reach the end. The finalise reply carries `unmeasured`, the count still to measure, and `pixelslash upload` finalises again by itself while that falls (a warning on stderr for each); if it stops with shots left it warns that the build is `errored` and exits 0 as before. A hard kill by the runtime (one shot alone passing 30 s, or the isolate limit) cannot be caught in the request and can leave the build at `processing`; recovering a build stuck that way is a separate ticket. None of this applies to a `ci` project: its finalise reads no PNG and has no budget. An errored `ci` build is never measured again: finalising it again is a 409, and the build page says to re-run the CI job.

**One shot's diff failing does not stop the others.** A shot whose server diff throws (its baseline missing from storage, a PNG that does not decode) keeps the reason in its `diffError` and is left unmeasured; the rest are measured, and the build ends `errored` naming each failed shot (`N of M shots could not be measured…`). The build page of an errored server-diff build has **Re-run errored shots** (the same as sending finalise again: only the shots with no result are measured), and on a build with a verdict each shot's page has **Re-run this shot**, which measures that one shot again. Both work from the PNGs the server holds (nothing is captured), and the build gets its verdict once none is left unmeasured; a picked shot whose re-diff fails loses its review and errors the build. A re-run shot whose result is the same keeps its review; one whose result moved goes back to pending (and is accepted again on the default branch, unless it is flaky). A `ci` project has neither control, and the server refuses the re-run (ob 1738).

**A build never claims a verdict on a shot it did not measure** (PS-282). A shot whose fingerprint differs from its baseline's is not compared (`rebaseline_needed`, counted as `rebaseline`). On the default branch it is accepted and becomes the new baseline. On any other branch the build ends `errored`, naming how many shots and what moved (`fonts sha256:… → sha256:…`), so `pixelslash upload` exits 1: upload the default branch from the new environment, then rebase the branch onto that commit and upload it again (main's shots count only at the merge-base or its ancestors), and the server diff measures each such shot against main's new baseline (an open change from the old environment is not carried across). A `ci` project is not moved to main's baseline: `POST /builds/:id/baselines` is not told the shot's fingerprint, so it still names the branch's own baseline, and that branch's builds stay `errored` after an environment change. A shot left with no result at all errors the build too (`N of M shots have no result`). A build with no result on a shot is never the next build's baseline, so the branch's open changes are still carried past it.

Sending a snapshot again (same name, platform, browser, viewport, theme) replaces it. Finalising checks the server holds exactly N snapshots (409 otherwise) and closes the build: after that every write is a 409, and finalising again with the same N is a harmless retry. A CI token only reaches its own project's builds, an org token the projects of its org, a personal token the projects of its user's orgs; any other project or build id is a 404. 401 is a missing, wrong, expired or revoked token.

**What a shot is compared against (its baseline).** Each shot is matched by name, platform, browser, viewport and theme, and the server picks one earlier shot for it:

1. **The branch's last build.** The same shot from the newest earlier build on the same branch whose build was not rejected, reviewed or not. A second build of an unchanged commit therefore shows 0 changed: a re-run shows only what moved since the last one. A shot accepted on build 1 and unchanged on build 2 passes on build 2.
2. **Otherwise, the accepted shot on the base.** The accepted shot from a build at the nearest of the merge-base and its ancestor SHAs (up to 200, nearest first; within one commit, the newest build). A project whose last main build is far behind the merge-base, because CI skipped it as unaffected, is fine: that build is the baseline, and a main build after the merge-base never is. A build on the project's default branch (`main` unless changed on the project's settings page) is auto-accepted, so on that branch rule 1 and rule 2 pick the same shot. A build on any other branch, `main` included when it is not the default, waits for review.

A change that is still open on the branch's last build (pending, never accepted or rejected) is not dropped by rule 1:

- A shot identical to it is stored `unchanged` with 0 changed pixels, and it **carries** that change: it still counts as "to review", its card says so and links to the build where the change was measured, and the build stays `changes` until it is decided. A third build carries from the shot that measured the change, not from the carrier.
- A shot that differs from it is measured against rule 2's accepted shot instead, and is `changed` against that. Diffing it against the unreviewed shot would let one acceptance approve a change no one has seen.
- A decision on any shot of a carried change (the one that measured it or any carrier) is the decision on all of them, in every build that is `changes` or `passed`, and each of those builds moves to its new verdict. Accepting the earliest build passes the later ones; rejecting a carrier fails every build of the change.
- **A difference from main is open until it is decided (PS-284).** A shot that is `unchanged` against the branch's last build but differs from main (`changed` or `new` against rule 2's shot) and was never accepted along the chain of builds it matches carries that difference too, from the root of the chain, so the build is `changes` and a single decision settles every build of it. This covers a previous build that ended `passed` without carrying the change (a build whose shots were never measured, before PS-282). The pixel diff and the baseline picks are unchanged. The build page and the check run count and list such a shot under its status against main (Changed or New, not Unchanged; PS-285): the tabs, the summary sentence, the check table and the j/k walk all agree with the verdict. `GET /api/v1` keeps the measured value: its `counts` and each snapshot's `group` still say `unchanged`, and `carried_from` marks the shot.
- **A new shot on a branch waits for review like a change** (it used to pass). A build whose every shot is `unchanged` against main still ends `passed`; removed shots never block. The GitHub check run's summary names the shots that wait (up to 10, then "and N more").
- Re-running a shot of a build (the rerun path) recomputes the carry over the whole build and its verdict, so a build that ended `passed` on open changes is corrected without a new upload. Only the carry is added to shots of that build; no stored diff result, review decision or verdict of another build is rewritten. The carry reads the comparison with main, so a shot that comparison could not measure (out of budget, a different environment than main's) is not carried and still passes.
- A rejected build is never a baseline, so the next build on its branch is measured against rule 2.
- Known gap: a carrier whose build is still diffing when the change is decided is not moved with it. It stays "to review" until someone decides it there; that decision changes nothing on the builds already decided. An `errored` build is not affected: a resumed finalise picks its baselines again, so its carrier follows the decision (passes after an accept, is measured again against rule 2 after a reject).

### Block CI on review

`pixelslash status --wait` holds a CI job until the build is decided. It reads the build every `--interval` (default 15s) until the server has finished processing it and no shot waits for review, then exits 0 (all accepted, or nothing changed) or 4 (a shot rejected). Still waiting at `--timeout` (default 30m) is exit 5, and a build that `errored` is exit 3. While it waits it writes the counts to stderr each time they move. A flaky shot under `"flaky": "skip"` never waits: it is listed on its own `skipped flaky:` line and does not hold the job. `--timeout` or `--interval` without `--wait` is exit 2; durations are `500ms`, `15s`, `30m` or `1h`, and a bare number is seconds.

Plain shell steps, the same on any CI. The job needs the full history for the merge-base and its ancestors (GitHub Actions: `actions/checkout` with `fetch-depth: 0`), and the project's CI token in `PIXELSLASH_TOKEN`:

```sh
export PIXELSLASH_SERVER=https://<server>
export PIXELSLASH_TOKEN="$PIXELSLASH_CI_TOKEN"   # the CI's secret store, never git

pixelslash capture --config pixelslash.config.ts     # or `pixelslash import PNG_DIR`
pixelslash upload pixelslash-snapshots --wait --timeout 30m
# exit 0 accepted or unchanged · 4 rejected · 5 still waiting · 3 server or build error · 2 usage
```

To keep the upload and the wait in separate steps (a separate job, or a retry of the wait alone), run `pixelslash upload pixelslash-snapshots`, then `pixelslash status --wait` from the same working dir: it reads the build from `pixelslash-snapshots/build.json`. A job with no snapshot dir names the build with `--build`, `--commit "$COMMIT_SHA"` or `--branch NAME`. This calls no GitHub or GitLab API and comments on no PR; the job's own pass or fail is the signal.

### A monorepo: one org token

A monorepo has many projects, and one `psci_` token per project is tedious. Mint one **org token** (`psorg_…`) under Organizations → Tokens (any member can; it is shown once and can be revoked there), keep it as the CI's one secret, and name the project on each step. `project create` makes the project if the org has none of that name and otherwise says it exists, so it is safe to run on every build:

```sh
export PIXELSLASH_SERVER=https://<server>
export PIXELSLASH_TOKEN="$PIXELSLASH_ORG_TOKEN"   # the CI's secret store, never git

for pkg in web docs admin; do
  pixelslash project create "$pkg"                # created: … or already exists: …, exit 0 either way
  pixelslash capture --config "packages/$pkg/pixelslash.config.ts" --out "snapshots/$pkg"
  pixelslash upload "snapshots/$pkg" --project "$pkg"
done
```

- `project create NAME` prints the project's id and name and whether it was `created` or `already exists`; `--json` prints the server's reply (`created` is a boolean). Exit 0 both ways, 1 when the server refuses, 2 on a usage error. `project list` prints the projects the token reaches.
- An upload never creates a project. A name the org does not have is exit 2 naming it (and `project create NAME`), so a typo makes no stray project.
- An org token reaches the projects of its org and nothing else: another org's project is a 404. Per-project `psci_` tokens keep working as before.

### Check before you push

`pixelslash check` measures this checkout against the baselines the server would pick for it, and uploads nothing. It is `capture`, then the server's pick, then `compare`, all on this machine:

```
pixelslash check [--config FILE] [--out DIR] [--base BRANCH] [--only NAME]... [--server URL] [--token-path PATH] [--project ID|NAME] [--flake-retries N] [--json]
```

- It captures the config's routes into `DIR/branch` (default `DIR` is `pixelslash-check`). The app must already be up: `check` starts no dev server, and a down `baseUrl` fails. `--only NAME` (repeatable) captures just those routes; an unknown name is exit 2.
- It asks `POST /api/v1/baselines` for each shot's pick, with the commit, branch and local merge-base (`--base`, else `upload.baseBranch`, else `main`). That endpoint creates nothing. The CLI does not pick baselines; it downloads the ones the server names into `DIR/main` and settles a carried change the way finalise does.
- It diffs `DIR/main` against `DIR/branch` with `compare`'s code and writes the same `DIR/report/index.html` and per-shot reports, headed as a local preview. A shot the baseline build holds and this capture lacks is **removed** (only among the `--only` routes, when given).
- A shot whose fingerprint differs from its baseline's is named per shot and **diffed anyway**, as `compare` does.
- A changed shot is captured again `--flake-retries` times (default `flake.retries` in the config, else 2). A shot that differs from itself is marked flaky in the index, with the flake report beside it.
- stdout is the counts (`N changed, N unchanged, N new, N removed`), the `changed:` / `new:` / `removed:` name groups as `compare` prints them (capped at 10 each, `+N more`), a `fingerprint:` line when any differ, one `flaky:` line per flaky shot, `measured locally: a preview, nothing uploaded`, and `report: file://…`. `--json` prints `{ measured: "local", uploaded: false, git, counts, report, flakeReport, dirs, shots, timings }`, where `counts.removed` is `null` (and stdout says `removed not reported by this server` in place of `N removed`) when the server does not report what it would remove, as one from before ob 1732 does not, and each shot has its `status`, `changedPixels`, `regions`, `mismatch`, `flaky` and absolute file paths.
- Exit 0 whether or not anything changed. Exit 2 on a usage error, 3 when the server refuses the token or cannot be reached, 1 when the capture fails.

### Reviewing the review app with itself

`bun run dogfood:upload` (in `apps/web`) captures the review app's own project, build and snapshot pages, light and dark, from a local build, and uploads them, so a UI change to `apps/web` is a build to review in our own workspace. It is a local script: there is no CI file for it.

```
PIXELSLASH_SERVER=https://<server> PIXELSLASH_TOKEN_FILE=<path to a project's CI token> \
  bun run dogfood:upload -- --branch NAME [--base main] [--pr N]
```

- Both variables are required (use an absolute token path; a `~` in the value is not expanded) and nothing is hard-coded: the shots go only to the server named, and the token file is given to the CLI as `--token-path` (nothing here reads it, and it is never in git). The script is one `package.json` line over `pixelslash capture --upload`; the snapshot dir `.wrangler/dogfood-snapshots` is cleared on every run.
- The capture is `apps/web/e2e/dogfood-review.config.ts`: the same `start` and `setup` as the organizations-page dogfood (`dogfood-orgs.config.ts`), over the fixed seed in `dogfood-seed.ts`, whose shots now have real PNGs (`dogfood-images.ts`, written to the local bucket by the setup) so the build and snapshot pages render. Six shots: three pages × two themes. It shares `.wrangler/e2e` and `dist/` with the e2e suite, so do not run it while `nx test:e2e web` runs.
- Upload once from the commit you compare against with `--branch main`, then from the branch: the server's baseline rules above apply, and only the pages a change touched land in Changed. Capture outside the pinned image records a `bare` fingerprint, so compare like with like: shots from the same machine, or the pinned image on both sides.

## API

Everything under `/api/v1` is one JSON API, for the CLI, the MCP server and any other integration. Send the token as `Authorization: Bearer <token>`:

- A **CI token** (`psci_…`) reaches its one project.
- An **org token** (`psorg_…`, issued by any member under Organizations → Tokens) reaches every project of its org and nothing else. It names the project in the request, as a personal token does, and can create one by name (`POST /api/v1/projects`). An upload never creates a project: an unknown project is a 404.
- A **personal token** (`psu_…`) acts as its user and reaches every project of that user's orgs.
- A project, build or snapshot the token cannot reach is a **404**, never a 403, so a 404 does not tell you whether the id exists.

**`/api/v1` is a stable contract.** A field or an endpoint may be added; nothing is renamed, retyped or removed. A breaking change is `/api/v2`. Clients should ignore fields they do not know.

| Request | Auth | Query or body | Reply |
| --- | --- | --- | --- |
| `GET /api/v1/me` | CI, org or personal | — | `200 { kind: "user", user: { id, login, name } }`, `200 { kind: "ci", projectId }` or `200 { kind: "org-ci", orgId }` |
| `POST /api/v1/builds` | CI, org or personal | JSON `{ commitSha, branch, mergeBaseSha?, ancestorShas? (≤200, more is a 400), prNumber?, projectId?, clientDiff?, brief? }`; `brief` is trimmed and at most 4000 characters (422 otherwise); `projectId` is required with a personal or org token; a `ci` project needs `clientDiff: true` (426 otherwise) | `201 { id, diffLocation }` |
| `POST /api/v1/builds/:id/baselines` | CI, org or personal | JSON `{ keys: [{ name, platform, browser, viewport, theme }] }` (≤2000) | `200 { diff_location, baselines: [pick] }`, one per key, in order |
| `POST /api/v1/baselines` | CI, org or personal | JSON `{ keys, commitSha, branch, mergeBaseSha?, ancestorShas?, projectId? }`: the pick a build at this commit would get now; creates nothing | `200 { diff_location, baselines: [pick], removed: [{ name, platform, browser, viewport, theme }] }`: `removed` is what the baseline build holds and no key asked about |
| `PUT /api/v1/builds/:id/snapshots` | CI, org or personal | multipart: `meta` (JSON `{ name, platform, browser, viewport, theme, tags, diff?, ignore?, fingerprint, flaky?, ci?, flake?, changeNote?, composition?, a11y? }`), `file` (PNG, ≤32 MiB); in a `ci` project, one `diff:<baselineId>` mask PNG per result in `ci`; for a flaky shot, one `flake:<run>` PNG per re-capture (≤32 MiB each, counted in the request's size cap) | `200 { id }` |
| `POST /api/v1/builds/:id/finalize` | CI, org or personal | JSON `{ snapshots: N, timings? }`: `timings` is the CLI's [step timings](#step-timings), optional and stored as sent when well formed | `200 { id, status, error, unmeasured, web_url }`: `web_url` is the build's page in the web app, which the CLI prints when it fails an upload on an `errored` build |
| `GET /api/v1/projects` | CI, org or personal | — | `200 { projects: [project], next_cursor: null }`: a personal token's projects, ordered by org then name; an org token's org's; a CI token's one project |
| `POST /api/v1/projects` | org or personal | JSON `{ name, org? }`: `name` is 1 to 100 characters; `org` (an id or exact name) is needed only when a personal token belongs to several orgs, and an org token's is its own | `201 { …project, created: true }` for a new project, `200 { …project, created: false }` for the one of that name already in the org (idempotent). A project's `ci` token is a 403; an unknown `org` a 404 |
| `GET /api/v1/projects/:id/builds` | CI, org or personal | `branch?`, `status?` (`uploading`, `processing`, `changes`, `passed`, `failed`, `errored`), `limit?`, `cursor?` | `200 { builds: [build], next_cursor }`, newest first |
| `GET /api/v1/builds/:id` | CI, org or personal | — | `200 { build: { …build, snapshots: [snapshot] } }`, snapshots in review order |
| `GET /api/v1/snapshots/:id` | CI, org or personal | — | `200 { snapshot: { …snapshot, images: { head, baseline, diff } } }` |
| `GET /api/v1/projects/:id/detection-flags` | CI, org or personal | `limit?`, `cursor?` | `200 { detection_flags: [flag], next_cursor }`, newest first: the mis-detections reviewers flagged on the snapshot page |
| `POST /api/v1/detection-flags/:id/exported` | personal | — | `200 { detection_flag: flag }`, with `exported_at` set: the flag was turned into a bench case (`bun run bench:import-flags`); marking it again keeps the first time, and a CI token gets 403 |
| `GET /api/v1/projects/:id/flakes` | CI, org or personal | — | `200 { flakes: [flake], next_cursor: null }`, open ones first, then the most recently changed |
| `POST /api/v1/flakes/:id/resolve` | personal | JSON `{ note? }` (≤200 characters) | `200 { flake }`, with `resolved_by` the token's user; a CI token gets 403 |

There are no write endpoints besides the four upload ones, creating a project by name (`POST /api/v1/projects`), resolving a flake and marking a detection flag exported: accepting and rejecting stay in the web app. The two `baselines` endpoints are `POST` only because they take a list; they change nothing.

**The upload endpoints** (`me`, `builds`, `snapshots`, `finalize`) are the ones the shipped CLI speaks. They keep their camelCase keys, carry no `api_version`, and answer an error as `{ "error": "<message>" }`.

**The read endpoints** (`projects`, `builds` lists and reads, `snapshots`, `detection-flags`, `flakes`, `baselines`), resolving a flake and marking a flag exported use snake_case keys, and every reply carries `"api_version": 1`. An error is:

```json
{ "api_version": 1, "error": { "code": "not_found", "message": "build not found" } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | a bad `status`, `limit` or `cursor` |
| 401 | `unauthorized` | a missing, wrong, expired or revoked token |
| 403 | `forbidden` | a CI token resolving a flake or marking a flag exported (only a person does) |
| 404 | `not_found` | an unknown path, or an id the token cannot reach |
| 405 | `method_not_allowed` | a path that exists, with another method |
| 426 | `cli_outdated` | the CLI is older than the server takes (below) |
| 429 | `rate_limited` | too many requests from one token (or, for a refused token, one IP); wait and retry (below) |

The upload endpoints also answer 409 (a write to a finalised build, or a finalise whose count is wrong) 413 (a PNG over 32 MiB) and 422 (a brief over 4000 characters); their codes are `conflict`, `too_large` and `unprocessable` if a read endpoint ever needs them.

**Rate limits.** On Cloudflare, every endpoint counts requests per token, and a refused token's per client IP, against the `API_RATE_LIMIT` binding in `apps/web/wrangler.jsonc` (3000 a minute, far above an upload's pace). Over it, the answer is **429** with `Retry-After: 60`; on a read endpoint the code is `rate_limited`, on an upload endpoint the message is the plain-string error. A self-host without the binding is never limited.

**Pagination.** A list that can grow (`builds`, `detection-flags`) returns at most `limit` rows (default 50, at most 100) and a `next_cursor`. Pass it back as `cursor` with the same filters for the next page. `next_cursor` is `null` on the last page. A cursor is opaque: a malformed one is a 400. `projects` is not paginated yet: its length is the projects of your orgs, and its `next_cursor` is always `null`, so a client that follows it keeps working when it is.

**The CLI version.** The CLI sends `User-Agent: pixelslash/<version>`. A server whose `MIN_CLI_VERSION` var is set (`x.y.z`, in `wrangler.jsonc`; empty takes any) refuses an older CLI on every endpoint with **426**, before it checks the token. The message is `upgrade the CLI: this server needs pixelslash <x.y.z> or newer`. On a read endpoint the code is `cli_outdated`; on an upload endpoint the message is the plain-string error. Any other client is never refused for its User-Agent, and neither is a CLI from before the User-Agent was sent (it reads as another client).

A **project**:

```json
{
  "id": "…",
  "name": "web",
  "org": { "id": "…", "name": "Acme" },
  "default_branch": "main",
  "created_at": "2026-10-22T09:00:00.000Z",
  "web_url": "https://<server>/projects/…"
}
```

A **build**. `counts` has one count per group (`changed`, `new`, `removed`, `unchanged`, `rebaseline`, `unmeasured`), one per review state (`pending`, `accepted`, `rejected`), `to_review`: the shots still waiting for a decision, and `skipped_flaky`: the changes on flaky shots whose policy is `skip`, which wait for no one. Builds have no sequence number; `id` and `created_at` identify one.

```json
{
  "id": "…",
  "project_id": "…",
  "branch": "feature",
  "commit_sha": "4f2c…",
  "pr_number": 42,
  "status": "changes",
  "error": null,
  "counts": {
    "changed": 1, "new": 1, "removed": 1, "unchanged": 1, "rebaseline": 0, "unmeasured": 0,
    "pending": 4, "accepted": 0, "rejected": 0, "to_review": 1, "skipped_flaky": 0
  },
  "created_at": "2026-10-22T09:00:00.000Z",
  "web_url": "https://<server>/projects/…/builds/…"
}
```

A **snapshot**:

- `group` is the section the build page shows it under.
- `awaits_decision` is whether it still counts toward `to_review`.
- `carried_from` is set on an unchanged shot that carries an open change from an earlier build (see "What a shot is compared against" above).
- `approved_earlier` is set on an unchanged shot whose change was already accepted on this branch.
- `flake_id` is the flake the shot is labelled with, or `null`; `flaky_policy` is the policy it was sent with (`review`, `skip`, or `null` for none, which is `review`); `skipped_flaky` is whether its change is skipped as flaky (see "Flaky shots").
- `diff_result` is `null` until the diff has measured it. Its regions are in image px.

```json
{
  "id": "…",
  "build_id": "…",
  "name": "about",
  "platform": "linux",
  "browser": "chromium",
  "viewport": "1280x720",
  "theme": "light",
  "tags": [],
  "group": "changed",
  "diff_status": "changed",
  "diff_result": {
    "changed_pixels": 144, "antialiased_pixels": 0, "ignored_pixels": 0, "ignored": [], "specks": 0,
    "regions": [{ "x": 8, "y": 8, "w": 12, "h": 12, "changed_pixels": 144, "antialiased_pixels": 0, "kind": "change", "why": null }],
    "width": 1280, "height": 720, "main_width": 1280, "main_height": 720,
    "branch_width": 1280, "branch_height": 720, "size_changed": false
  },
  "rebaseline_needed": false,
  "review_state": "accepted",
  "reviewed_by": "ada",
  "reviewed_at": "2026-10-22T09:05:00.000Z",
  "awaits_decision": false,
  "carried_from": null,
  "approved_earlier": null,
  "flake_id": null,
  "flaky_policy": "review",
  "skipped_flaky": false,
  "measured_by": "ci",
  "engine_version": "0.1.0",
  "diff_error": null,
  "created_at": "2026-10-22T09:00:00.000Z",
  "web_url": "https://<server>/projects/…/builds/…/snapshots/…"
}
```

`measured_by` is `ci` or `server`: who measured `diff_result`. `engine_version` is the engine that measured it. Both are `null` on a shot that was not measured or that was measured before this field existed. `diff_error` names why a `ci` project's result for the shot was refused (see "Where the diff runs"), and is otherwise `null`.

`carried_from` is `{ snapshot_id, build_id }`. `approved_earlier` is `{ snapshot_id, build_id, commit_sha, reviewed_by, reviewed_at, default_branch }`.

`GET /api/v1/snapshots/:id` adds `images`: absolute URLs to the head shot, the baseline it was compared against, and the diff overlay. They go through the app's signed image route, need no token, and **expire after 5 minutes**: read the snapshot again for fresh ones. `baseline` and `diff` are `null` when there is none (a new shot, or one not yet measured).

A **pick** (from either `baselines` endpoint):

```json
{
  "key": { "name": "home", "platform": "linux", "browser": "chromium", "viewport": "1280x720", "theme": "light" },
  "baseline": {
    "id": "…",
    "image_url": "https://<server>/images/…",
    "fingerprint": { "image": "…", "browser": "…", "fonts": "…" },
    "ignore": [{ "x": 0, "y": 0, "width": 10, "height": 10 }]
  },
  "carry": null,
  "accepted": null
}
```

- `baseline` is `null` for a new shot.
- `image_url` expires after 5 minutes, like the snapshot `images` above.
- A shot is compared only when its fingerprint matches `fingerprint`.
- The thresholds are the shot's own diff options as uploaded, so they are not in the reply.
- `carry` is set when `baseline` holds an open change (ob 1712). A shot identical to `baseline` carries that change. A shot that differs from it is measured against `accepted` instead, which has the same shape as `baseline`, or is `null` when there is none.

A **detection flag**:

```json
{
  "id": "…",
  "kind": "missed",
  "note": "button moved",
  "rect": { "x": 1, "y": 2, "w": 3, "h": 4 },
  "by": "ada",
  "snapshot": { "id": "…", "name": "home", "platform": "linux", "browser": "chromium", "viewport": "1280x720", "theme": "light" },
  "build": { "id": "…", "branch": "feature", "commit_sha": "4f2c…" },
  "measured": { "diff_status": "unchanged", "changed_pixels": 0 },
  "images": { "head": "https://<server>/images/…", "baseline": "…", "diff": null },
  "created_at": "2026-10-22T09:00:00.000Z",
  "updated_at": "2026-10-22T09:00:00.000Z",
  "exported_at": null,
  "web_url": "https://<server>/projects/…/builds/…/snapshots/…"
}
```

`kind` is `missed` (a change the diff did not mark) or `false_positive` (one it marked that is not a change). `rect` is the box drawn on the shot, or `null`. `exported_at` is when the flag was turned into a bench case, or `null`; a reviewer editing the flag clears it.

A **flake**:

```json
{
  "id": "…",
  "name": "home", "platform": "linux", "browser": "chromium", "viewport": "1280x720", "theme": "light",
  "status": "open",
  "note": null,
  "created_by": null,
  "created_at": "2026-10-22T09:00:00.000Z",
  "resolved_by": null,
  "resolved_at": null,
  "resolution_note": null,
  "updated_at": "2026-10-22T09:00:00.000Z",
  "evidence": [{
    "build_id": "…", "snapshot_id": "…",
    "runs": 3, "differed": [2], "regions": [{ "run": 2, "regions": [{ "x": 8, "y": 8, "w": 12, "h": 12, "changed_pixels": 144, "antialiased_pixels": 0, "kind": "change", "why": null }] }],
    "engine_version": "0.1.0", "policy": "review",
    "at": "2026-10-22T09:00:00.000Z",
    "images": { "head": "https://<server>/images/…", "runs": [{ "run": 2, "url": "https://<server>/images/…" }, { "run": 3, "url": "…" }] },
    "web_url": "https://<server>/projects/…/builds/…/snapshots/…"
  }]
}
```

`status` is `open` or `resolved`. `created_by` is the reviewer who marked it flaky by hand, or `null` when the CLI detected it; a hand mark has no evidence. `evidence` is one entry per build that detected it, oldest first. `images.head` is the run-1 capture the build stored as the shot; `runs` are the re-captures, with the same 5-minute expiry as the snapshot images.

## Local-screenshot dogfood (GTK windows)

Capture two windows with grim (automation is later), then compare:

```
grim -g "$(slurp)" /tmp/widget-main.png
grim -g "$(slurp)" /tmp/widget-branch.png
bun run pixelslash -- --live-png /tmp/widget-main.png --local-png /tmp/widget-branch.png --label widget
```

Open the printed `report.html`.

URL pair, no design system (pages already up):

```
bun run pixelslash -- --live https://example.com --local http://127.0.0.1:4173 --out .pixelslash
```

Main vs a branch preview, with a design system:

```
bun run pixelslash -- --live https://example.com --local http://127.0.0.1:4173 --ds fixtures/ds --out .pixelslash
```

Several routes, no design system (origins already up):

```
bun run pixelslash -- --live https://example.com --local http://127.0.0.1:4173 --routes routes.txt --out .pixelslash
```

Several routes, with a design system:

```
bun run pixelslash -- --live https://example.com --local http://127.0.0.1:4173 --routes routes.txt --ds fixtures/ds --out .pixelslash
```

Local screenshot shots (no URL, no Playwright, no DS):

```
bun run pixelslash -- --live-png main.png --local-png branch.png --out .pixelslash
```

GTK dirs + routes:

```
bun run pixelslash -- --live-png-dir shots/main --local-png-dir shots/branch --routes routes.txt --ds fixtures/ds --out .pixelslash
```

`--ds DIR` is in-repo fixture rasters. `--file FILE_KEY` lists Figma components, writes pngs, then the same compare loop. Token from `FIGMA_TOKEN` or `--token-path` (never git).
