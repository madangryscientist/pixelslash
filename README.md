# PixelSlash

Page vs design-system, vision-first — plus a pixel dashboard of Main vs Branch. Local mlx, else ollama. A standalone Bun CLI.

```
bun install
bun run pixelslash -- install-browser   # once, for URL capture (Playwright's chromium-headless-shell)
bun run typecheck   # nx: tsc on every project
bun run lint        # nx: oxlint (type-aware) + check-slop
bun run format:check
bun run test        # nx: vitest on every project
bun run pixelslash -- <args below>
```

```
bun run pixelslash -- (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--label TEXT] [--threshold 0..1] [--min-changed-pixels N] [--min-changed-ratio 0..1] [--merge-distance PX] [--min-region-area PX] [--noise-amplitude 0..1] [--max-shift 0..1] [--ignore x,y,w,h]...
```

`--live` is **Main** (prod or a main preview). `--local` is **Branch** (this worktree's preview). Both URLs must already be up — the command does not start a dev server. Each capture waits for the page to settle before shooting: web fonts, every image, a short network-idle window, then two animation frames — all bounded by the capture timeout, so a page that never settles fails rather than hangs.

A URL pair may omit `--ds` and `--file`. PixelSlash captures both pages, pixel-diffs them, stores `main.png`, `branch.png`, `diff.png`, a manifest (`changedPixels`, `createdAt`, optional `--label`), and `report.html`, and exits 0. stdout points at `report.html`. Same store as PNG mode. Identical shots still store a run (`changedPixels` 0). The diff is perceptual: a pixel counts toward `changedPixels` only when its colour differs by more than a small YIQ threshold (alpha blended over white) and it is not an anti-aliased edge in either shot, so `changedPixels` is smaller than a raw pixel-difference count. If width or height differs, only the overlapping rectangle is diffed: `changedPixels` is that overlap count, the report states both sizes, the non-overlap is not painted as changed, and the engine's verdict (`changed`) is true because the sizes differ. The changed pixels are then clustered into **regions** (`regions[]` in the manifest and the engine result): boxes with `x`, `y`, `w`, `h`, `changedPixels` and `antialiasedPixels`. Changed pixels and boxes closer than 24px are one region (`mergeDistance`); a box with an area under 4px (`minRegionArea`) is a speck, dropped and counted in `specks`; a region that is faint (90th percentile of colour distance at most 0.25, no pixel above 0.5), uneven (the spread of those distances is at least 0.3 of their mean, so a flat element that moved is never noise), and moves both lighter and darker (minority share at least 0.2), is labelled `noise`, kept in `regions`, and does not make the run `changed`. A region whose content moved by a fraction of a pixel, all alike (`maxShift`, 0 to 1; default 0.9), is labelled `shift`: the region's own box fits one sub-pixel shift on both axes, that fit explains at least a quarter of its colour difference, and the edge tiles in a 24px halo around the box agree with the same shift; a whole pixel moved, or a neighbour that stayed put, keeps it a `change`. `shift` regions are kept in `regions`, are drawn in their own style, and do not make the run `changed`. `changed` is true when the sizes differ or a `change` region survives. The numbers were chosen on `bench/corpus` (see `bench/README.md`). Default `--out` is `.pixelslash`.

`--threshold` (per-pixel tolerance, 0 to 1; engine default 0.01), `--min-changed-pixels` and `--min-changed-ratio` (floors on the run), `--merge-distance` (px; default 24), `--min-region-area` (px; default 4), `--noise-amplitude` (0 to 1; default 0.25) and `--max-shift` (pixels, 0 to 1; default 0.9; 0 turns the call off) tune the diff in every mode here. The floors combine with the region verdict, not beside it: they are measured on the pixels of the `change` regions that survive (noise and shift regions and specks never count), so a run is `changed` only when the sizes differ, or those surviving pixels are at least `--min-changed-pixels` and their share of the overlap is at least `--min-changed-ratio`. Out-of-range or non-numeric values exit 2. The counts are still reported when a floor says the shot is not changed. When the options differ from the engine defaults the report states them (`Diff options: threshold 0.2`, and `Not changed: … under the floors above` when a floor decided it) and the run's `manifest.json` records them as `diff`; with none set, the report says nothing and the manifest has no `diff`.

`--ignore x,y,w,h` (repeatable) is an area in image px that the diff skips: the pixels stay in both shots and the report draws a hatch over them, but nothing inside is counted, region-clustered or reported as changed. It is listed in the run's `ignored` and counted in `ignoredPixels`; the ratio floor's denominator is what was measured, so ignored pixels do not dilute it. Use it for a video, an ad, a map or live data — for secrets use a redact mask instead, which never reaches the PNG (see `masks` in the capture config). Pair mode only: it is refused with `--routes`.

`--live-png` / `--local-png` skip Playwright and use existing screenshots. `--ds` / `--file` may be omitted in this mode too: same pixel-diff store and `report.html`.

`--routes FILE` is one path per line (`/` `/pricing` …). `--live` and `--local` are origins. Without `--ds` or `--file`, each path is two captures, a pixel diff (`main.png`, `branch.png`, `diff.png`, manifest), and `report.html`. `--out/index.html` links those reports. Exit 0. With `--ds` or `--file`, each path is still two captures plus the DS judge. `--live-png-dir` / `--local-png-dir` is the GTK form (`index.png` for `/`, `pricing.png` for `/pricing`) and still needs `--ds` or `--file`.

With `--ds` or `--file`, one URL run captures both at the page width, then checks each shot against every DS component raster. Prefers `mlx_vlm.generate` when present (Mac). Else `ollama run qwen2.5vl` with the page shot, the DS raster, then the prompt (`ollama` on PATH; 100% local). PNG mode with `--ds` copies the given files into `--out` as `live.png` / `local.png` and runs the same judge. Reports violations already on Main vs NEW violations on Branch. Exit 1 if any NEW violations, else 0.

Install ollama and `ollama pull qwen2.5vl` (7b latest). Fallback if that does not fit: `ollama pull qwen2.5vl:3b && ollama cp qwen2.5vl:3b qwen2.5vl`. The CLI still spawns `qwen2.5vl`.

If both `mlx_vlm.generate` and `ollama` are missing, the HTML report still writes (shots + DS, no fake violations), stdout prints `skip: no judge`, and the process exits 0. DS-match judge is optional and is not required for screenshot pixel runs.

A one-pair run without a design system writes `--out/report.html` (open as `file://`): the changed-pixel count, the region and speck counts, both sizes, and Main, Branch and Diff. A changed shot (a `change` region survives) leads with those three **cropped to the changed region** — the union of the `change` regions plus 24px, clipped to the overlap of the two shots, scaled up with CSS so no extra file is written — and the full frame sits behind a `Full frame` click, where the Diff carries the region boxes (yellow for a change, dashed grey for noise). A shot with no `change` region keeps the full frame as is. With `--ds` or `--file`, that file is header counts, side-by-side Main/Branch shots, DS rasters, and the violation list. With `--routes`, open `--out/index.html`.

## Snapshot capture (the pinned image)

`pixelslash capture` shoots every route × variant in a config into a snapshot dir plus `manifest.json`, for upload to a PixelSlash server. Run it inside the pinned capture image: it fixes Bun, Playwright, Chromium and the font set, so the same commit renders the same pixels on any CI runner.

```
docker build -f docker/capture/Dockerfile -t pixelslash-capture:dev .
docker run --rm --network host -v "$PWD:/work" pixelslash-capture:dev capture [--config FILE] [--out DIR]
```

`--config` defaults to the first `pixelslash.config.{ts,js,mjs,json}` in the working dir (JS/TS: the default export). `--out` defaults to `pixelslash-snapshots`. Exit 0 on success, 1 when a page cannot be captured or the start command fails, 2 on a bad flag or config.

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
- `setup` is the way in to pages behind sign-in: the path to a JS/TS module (relative to the config file) whose default export is an async function. It runs once, after `start` is ready and before the first shot, with `{ page, context, baseUrl }` (Playwright, in a fresh context whose `baseURL` is `baseUrl`, at the first variant's viewport and on the real clock). Whatever it leaves in that context, cookies and local storage, is given to every shot. The session is held in memory only: it is never written to the snapshot dir, the manifest or an upload. A setup that throws fails the capture with exit 1 and names the file; one that cannot be loaded or does not export a function is exit 2. Type it with `CaptureSetup` from `@pixelslash/engine`.

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
- `variants` default to one: Chromium, 1280×720, light. `theme` sets `prefers-color-scheme`. `browser` must be one the image ships — today only `chromium`.
- `masks` are **redact**: CSS selectors (every match) or rectangles in full-page CSS px (scaled by the device scale factor); both are painted `#FF00FF` before the PNG is written, so the content never leaves the machine. A selector that matches nothing prints a warning. Use it for secrets and personal data.
- `ignore` is the opposite: areas the diff skips while the real pixels stay in the PNG, so the report can hatch them over the shots. Same shapes as `masks` — CSS selectors (every match) or rectangles in full-page CSS px — and every element carrying `data-pixelslash-ignore` is one without a config entry. Selectors are resolved to boxes in the live page at screenshot time, in full-page coordinates, scaled by the device scale factor and clipped to the image; nothing is painted. A selector that matches nothing prints a warning. It is allowed at the same three levels as `diff` (top level, on a route, per variant on a route), but the layers **add up** rather than override: project + route + variant. Use it for videos, ads, maps and live data. Capture only records the boxes: the diff that skips them is the pair-mode CLI's, or the server's once uploaded.
- `diff` sets the diff tolerance a snapshot is compared with, as `{ threshold?, minChangedPixels?, minChangedRatio?, mergeDistance?, minRegionArea?, noiseAmplitude?, maxShift? }` (the same keys as the pair-mode flags; unknown keys, a threshold, ratio or amplitude outside 0 to 1, or a non-integer pixel count is a config error naming the key). It is allowed at three levels: top level (the project default), on a route, and per variant on a route as `variants: { "<variant name>": { "diff": {…} } }` (the name must be one of the config's `variants`). The most specific wins, key by key: variant > route > project > engine default. So the `/dashboard` route above compares `mobile-dark` with `minChangedPixels: 50` and `threshold: 0.02`, and every other variant of it with `threshold: 0.02` only. The resolved options are written to each manifest entry as `diff` and uploaded; a key nobody set is left out so the engine default still applies to it. The config lives in your repo, so a tolerance is reviewed and versioned with the code.
- `flaky` is the flaky policy, `"review"` (the default) or `"skip"`. It is set at the top level (the project default) or on a route; a route's own wins. Any other value is a config error naming its path (`routes[2].flaky must be "review" or "skip"`). The resolved policy is written to each manifest entry as `flaky` and sent with a shot found flaky on upload; what it does to the build is the server's call. See "Flaky shots" under "Uploading to a server".
- `flake: { "retries": N }` is how many more times `--upload` captures a shot that differs from its baseline (default 2; 0 turns it off). It must be a non-negative integer; `--flake-retries` overrides it.
- `stabilise` defaults: animations and transitions off (finite ones jump to their end, infinite ones reset), caret hidden, `Date.now()` / `new Date()` frozen at `clock` (`false` for the real clock), page timers (`setInterval` / `setTimeout`) paused so carousels and tickers capture the same every time (`timers: false` lets them run; with `clock: false` they run too, and `timers: true` there is an error), device scale factor 1. Every capture also waits for the page to settle — fonts, images, network idle, two frames — bounded by `timeoutMs`; the settle cannot be turned off. With timers paused the settle never advances the page clock, so no timer fires during it either (a page that needs a delayed timer to render needs `timers: false`; Playwright's paused clock still runs zero-delay timers at load).

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
- stdout is `pixelslash: N changed, N unchanged, N new, N removed`, `fingerprint: N differ (diffed anyway)` when any differ, then `report: file://…/index.html`. Exit 0 whether or not anything changed: this is a viewer, not a gate. Exit 2 on a missing dir or manifest, a bad manifest or PNG, a missing argument, or an overlapping `--out`.

## Signing in and reading builds

The remote commands talk to a server's [API](#api) as one token. They read; only `upload` sends page shots.

```
pixelslash login [--server URL] [--config FILE]
pixelslash logout [--server URL] [--config FILE]
pixelslash whoami [--server URL] [--token-path PATH] [--config FILE] [--json]
pixelslash builds [--branch NAME] [--limit N] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash build ID|latest [--branch NAME] [--server URL] [--token-path PATH] [--project ID|NAME] [--config FILE] [--json]
pixelslash --version
pixelslash install-browser
```

- `login` asks for a personal token (`psu_…`; it prints where to make one: Settings → API tokens on the server, `<server>/settings`). On a terminal the token is read with echo off; otherwise it is the first line of stdin (`pixelslash login --server URL < token-file`). It checks the token with `GET /api/v1/me`, then stores it. A CI token (`psci_…`) is refused: CI passes its token by `PIXELSLASH_TOKEN` or `--token-path` instead. No token is ever printed.
- **The credential file** is `~/.config/pixelslash/credentials.json` (`$XDG_CONFIG_HOME/pixelslash/` when that is set), mode 0600 in a 0700 dir, one token per server: `{ "servers": { "https://ps.example": { "token": "psu_…" } } }`. `logout` removes the server's entry and does not revoke the token; revoke it on the settings page.
- `whoami` prints the server, where the token came from, and the user and their orgs (the orgs of the projects the token sees), or `CI token for project …`. `--json` is `{ server, via, me, orgs }`, with `me` the `/api/v1/me` reply.
- `builds` lists the project's builds, newest first (`--limit` 1 to 100, the API's own default otherwise), as a table: id, branch, commit, status, the count to review, and when. `build ID` prints one build, its counts, its web link and its snapshots; `build latest` is the project's newest build (on `--branch`, if given). With `--json` both print the API's reply byte for byte, unchanged: pipe it to `jq`.
- `--version` prints `pixelslash <version>`, the version the User-Agent sends. `install-browser` runs the Playwright that `capture` uses to install `chromium-headless-shell`.

**Resolution order**, the same for every remote command, `upload` included:

1. **Token:** `--token-path` (a file), else `PIXELSLASH_TOKEN` (CI), else the credential `login` stored for the resolved server.
2. **Server:** `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config (`--config`, or a `pixelslash.config.*` in the working dir).
3. **Project** (`builds`, `build latest`, `upload` with a personal token): `--project` (an id, or a name the token sees once), else `upload.project` in the config, else the only project the token sees. More than one and none named is exit 2, listing them.

**Exit codes:** 0 ok; 2 a usage error (a bad flag, no server, not logged in, no project picked); **3 the server did not give what was asked**: a refused, expired or revoked token (401), an id the token cannot reach (404), a server error, or a server that cannot be reached; `install-browser` also exits 3 when the install fails. Exit 1 stays the new-violations code, and `upload` keeps its own exit 1 for a refused upload. The client sends `User-Agent: pixelslash/<version>`.

## Uploading to a server

Nothing leaves the machine unless you ask: `pixelslash upload` and `pixelslash capture --upload` are the only commands that send page shots, and they send them only to the server you name. The same CLI talks to the hosted app and to a self-hosted one.

```
pixelslash upload DIR [--server URL] [--token-path PATH] [--project ID|NAME] [--base BRANCH] [--branch NAME] [--pr N] [--config FILE] [--flake-retries N]
pixelslash capture [--config FILE] [--out DIR] --upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--flake-retries N]
```

- `DIR` is a snapshot dir: a `manifest.json` and the PNGs it names (what `capture` writes). The whole manifest and every PNG are checked before anything is sent, so a bad dir never opens a build on the server.
- The token is a per-project CI token (`psci_…`, issued in the project's settings). A personal token (`psu_…`, issued under Settings → API tokens, with an optional 30-day, 90-day or 1-year expiry) acts as its user and reaches every project of that user's orgs; with one, `upload` names the project it opens the build in, resolved as in [Signing in](#signing-in-and-reading-builds) (`--project`, `upload.project`, or the only one the token sees). It comes from the file `--token-path` names, else `PIXELSLASH_TOKEN`, else the one `pixelslash login` stored for the server. Never put it in git.
- The server is `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config (`"upload": { "server": "https://…", "baseBranch": "main", "project": "web" }`; `upload` finds a config without `--config` only if one sits in the working dir, and runs fine without one).
- From the local git checkout it sends the commit, the branch, the **merge-base** with the base branch (`--base`, else `upload.baseBranch`, else `main`; `origin/<base>` is tried first) and up to **20 ancestor SHAs**, nearest first. Without the base branch in the checkout (a shallow clone) it warns and sends no merge-base: fetch full history in CI. The branch is `--branch`, else `GITHUB_HEAD_REF` / `GITHUB_REF_NAME`, else the checked-out branch; a detached `HEAD` with none of those is a usage error. The PR number is `--pr`, else read from `GITHUB_REF` (`refs/pull/N/…`).
- It opens a build, uploads each PNG, then finalises with the snapshot count; the server diffs inside that request. Exit 0 on success. Exit 1 when the server refuses (wrong or revoked token, 4xx/5xx) or cannot be reached; the build is then left open on the server, unfinalised, and its snapshots are not counted. The message names the step (`open build`, `upload <snapshot>`, `finalize`) and the server's answer in one line. A request the API never answered (the connection failed, a 502/503/504, or a 5xx that is not the API's `{"error"}` JSON, such as `vite preview`'s proxy page) is tried again after 1 s and 2 s, three tries in all, with a warning on stderr for each retry; an error the API itself answered is not retried. Every step is safe to repeat, and a repeated open at worst leaves an empty unfinalised build behind. A finalise whose answer is `processing` (a retry that met an earlier try's diff still running, or one the runtime killed) is exit 1: nothing has been measured yet. Exit 2 on a bad flag, a missing token or server, or a bad manifest. Re-running makes a new build.

What the server stores per snapshot: `name`, `platform`, `browser`, `viewport` (`WxH`), `theme`, `tags`, the resolved diff options (`diff`, stored as JSON in `snapshots.diff_options`; a client that sends none stores `{}`), the ignore boxes (`ignore`, JSON in `snapshots.ignore`, image px; a client that sends none stores `[]`), the environment fingerprint, and the PNG under the org's prefix in the blob store (R2 on Cloudflare). The manifest's `path` and the variant's `name` are not uploaded: a snapshot is identified by name + browser + viewport + theme, so two manifest entries that differ only by variant name are refused. The manifest carries no platform; `upload` sends `linux`, which is what the pinned capture image is.

The endpoints `upload` calls (`POST /api/v1/builds`, `POST /api/v1/builds/:id/baselines`, `PUT /api/v1/builds/:id/snapshots`, `POST /api/v1/builds/:id/finalize`), with their bodies and replies, are in [API](#api).

**Where the diff runs (`ci` or `server`).** Each project has a diff location, set on its settings page:

- **`ci`**: the CLI measures each shot in the CI job, with the same engine the server has, and the server only checks and stores what it sent.
- **`server`**: the server measures every shot when the build is finalised (below).

A new project on the hosted app is `ci`. A new project on a self-hosted server is `server`, unless its `DEFAULT_DIFF_LOCATION` var says `ci`. Projects from before the setting existed are `server`.

Changing the setting applies to the next build. The settings page warns about this: a build measured on one side is not guaranteed to match one measured on the other (the engine version can differ). A build that is open while its project is switched errors at finalise. Run it again.

The CLI does not pick baselines. `upload` and `capture --upload` always ask the server for each shot's baseline (`POST /api/v1/builds/:id/baselines`): the same pick that finalise makes, with the rules below. The reply says where the project diffs.

- **A `server` project:** the CLI uploads the PNGs as before, and the server diffs them. There is no flag to choose the other side: the project decides.
- **A `ci` project:** the CLI fetches each baseline image and diffs the shot against it, using the shot's own diff options and the ignore boxes of both shots. It sends `diff_result`, the status, the diff mask PNG and its engine version with the shot. When a baseline carries an open change and the shot differs from it, the CLI also measures the shot against the accepted shot, so the server has whichever result its pick needs.

Finalise in a `ci` project runs no diff. Each result is checked for shape and bounds against the shot's PNG header, without decoding a PNG, and its status must follow from its counts under the shot's thresholds. A shot whose result fails these checks is not measured on the server instead. Its `diff_error` names the reason, and the build ends `errored` naming every such shot. The failures are:

- no result;
- a result that is not a result;
- a **stale baseline**: the result was measured against a different shot than finalise picked, for example because another build landed in between.

Carries and the default branch's auto-accept work as on the server. A CLI from before this setting sends no results, so a `ci` project refuses it when the build is opened: `426 this project diffs in CI; upgrade the CLI`. A CLI talking to a server from before the setting skips the baselines request and uploads as before. Every snapshot records who measured it (`measured_by`: `ci` or `server`) and the engine version, and the snapshot page shows both.

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

**The server diff has a ceiling.** It runs inline in the finalise request, on a Worker with a 30 s CPU limit and a 128 MB isolate (decided 2026-10-20; no Queue for beta). Measured at 1280×4000: a typical shot takes about 0.8 s, a shot where every pixel differs about 15 s. One whole-page change fits; several do not. When the diff stops itself before the limit, the build ends `errored` and `error` names the limit (`diff ceiling: measured N of M shots…`); no shot is downscaled or cropped to fit. The finalise reply still carries `200`, so read `status` and `error`. A build too big for one run is resumed: finalise again and the server keeps what it measured and diffs the rest under the same budget, so repeated runs reach the end. The finalise reply carries `unmeasured`, the count still to measure, and `pixelslash upload` finalises again by itself while that falls (a warning on stderr for each); if it stops with shots left it warns that the build is `errored` and exits 0 as before. A hard kill by the runtime (one shot alone passing 30 s, or the isolate limit) cannot be caught in the request and can leave the build at `processing`; recovering a build stuck that way is a separate ticket. None of this applies to a `ci` project: its finalise reads no PNG and has no budget. An errored `ci` build is never measured again: finalising it again is a 409, and the build page says to re-run the CI job.

Sending a snapshot again (same name, platform, browser, viewport, theme) replaces it. Finalising checks the server holds exactly N snapshots (409 otherwise) and closes the build: after that every write is a 409, and finalising again with the same N is a harmless retry. A CI token only reaches its own project's builds, a personal token the projects of its user's orgs; any other project or build id is a 404. 401 is a missing, wrong, expired or revoked token.

**What a shot is compared against (its baseline).** Each shot is matched by name, platform, browser, viewport and theme, and the server picks one earlier shot for it:

1. **The branch's last build.** The same shot from the newest earlier build on the same branch whose build was not rejected, reviewed or not. A second build of an unchanged commit therefore shows 0 changed: a re-run shows only what moved since the last one. A shot accepted on build 1 and unchanged on build 2 passes on build 2.
2. **Otherwise, the accepted shot on the base.** The newest accepted shot from a build at the merge-base or one of the ancestor SHAs (nearest first). A build on the project's default branch (`main` unless changed on the project's settings page) is auto-accepted, so on that branch rule 1 and rule 2 pick the same shot. A build on any other branch, `main` included when it is not the default, waits for review.

A change that is still open on the branch's last build (pending, never accepted or rejected) is not dropped by rule 1:

- A shot identical to it is stored `unchanged` with 0 changed pixels, and it **carries** that change: it still counts as "to review", its card says so and links to the build where the change was measured, and the build stays `changes` until it is decided. A third build carries from the shot that measured the change, not from the carrier.
- A shot that differs from it is measured against rule 2's accepted shot instead, and is `changed` against that. Diffing it against the unreviewed shot would let one acceptance approve a change no one has seen.
- A decision on any shot of a carried change (the one that measured it or any carrier) is the decision on all of them, in every build that is `changes` or `passed`, and each of those builds moves to its new verdict. Accepting the earliest build passes the later ones; rejecting a carrier fails every build of the change.
- A rejected build is never a baseline, so the next build on its branch is measured against rule 2.
- Known gap: a carrier whose build is still diffing when the change is decided is not moved with it. It stays "to review" until someone decides it there; that decision changes nothing on the builds already decided. An `errored` build is not affected: a resumed finalise picks its baselines again, so its carrier follows the decision (passes after an accept, is measured again against rule 2 after a reject).

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
- A **personal token** (`psu_…`) acts as its user and reaches every project of that user's orgs.
- A project, build or snapshot the token cannot reach is a **404**, never a 403, so a 404 does not tell you whether the id exists.

**`/api/v1` is a stable contract.** A field or an endpoint may be added; nothing is renamed, retyped or removed. A breaking change is `/api/v2`. Clients should ignore fields they do not know.

| Request | Auth | Query or body | Reply |
| --- | --- | --- | --- |
| `GET /api/v1/me` | CI or personal | — | `200 { kind: "user", user: { id, login, name } }` or `200 { kind: "ci", projectId }` |
| `POST /api/v1/builds` | CI or personal | JSON `{ commitSha, branch, mergeBaseSha?, ancestorShas? (≤20), prNumber?, projectId?, clientDiff? }`; `projectId` is required with a personal token; a `ci` project needs `clientDiff: true` (426 otherwise) | `201 { id, diffLocation }` |
| `POST /api/v1/builds/:id/baselines` | CI or personal | JSON `{ keys: [{ name, platform, browser, viewport, theme }] }` (≤2000) | `200 { diff_location, baselines: [pick] }`, one per key, in order |
| `POST /api/v1/baselines` | CI or personal | JSON `{ keys, commitSha, branch, mergeBaseSha?, ancestorShas?, projectId? }`: the pick a build at this commit would get now; creates nothing | `200 { diff_location, baselines: [pick] }` |
| `PUT /api/v1/builds/:id/snapshots` | CI or personal | multipart: `meta` (JSON `{ name, platform, browser, viewport, theme, tags, diff?, ignore?, fingerprint, flaky?, ci?, flake? }`), `file` (PNG, ≤32 MiB); in a `ci` project, one `diff:<baselineId>` mask PNG per result in `ci`; for a flaky shot, one `flake:<run>` PNG per re-capture (≤32 MiB each, counted in the request's size cap) | `200 { id }` |
| `POST /api/v1/builds/:id/finalize` | CI or personal | JSON `{ snapshots: N }` | `200 { id, status, error, unmeasured }` |
| `GET /api/v1/projects` | CI or personal | — | `200 { projects: [project], next_cursor: null }`: a personal token's projects, ordered by org then name; a CI token's one project |
| `GET /api/v1/projects/:id/builds` | CI or personal | `branch?`, `status?` (`uploading`, `processing`, `changes`, `passed`, `failed`, `errored`), `limit?`, `cursor?` | `200 { builds: [build], next_cursor }`, newest first |
| `GET /api/v1/builds/:id` | CI or personal | — | `200 { build: { …build, snapshots: [snapshot] } }`, snapshots in review order |
| `GET /api/v1/snapshots/:id` | CI or personal | — | `200 { snapshot: { …snapshot, images: { head, baseline, diff } } }` |
| `GET /api/v1/projects/:id/detection-flags` | CI or personal | `limit?`, `cursor?` | `200 { detection_flags: [flag], next_cursor }`, newest first: the mis-detections reviewers flagged on the snapshot page |
| `GET /api/v1/projects/:id/flakes` | CI or personal | — | `200 { flakes: [flake], next_cursor: null }`, open ones first, then the most recently changed |
| `POST /api/v1/flakes/:id/resolve` | personal | JSON `{ note? }` (≤200 characters) | `200 { flake }`, with `resolved_by` the token's user; a CI token gets 403 |

There are no write endpoints besides the four upload ones and resolving a flake: accepting and rejecting stay in the web app. The two `baselines` endpoints are `POST` only because they take a list; they change nothing.

**The upload endpoints** (`me`, `builds`, `snapshots`, `finalize`) are the ones the shipped CLI speaks. They keep their camelCase keys, carry no `api_version`, and answer an error as `{ "error": "<message>" }`.

**The read endpoints** (`projects`, `builds` lists and reads, `snapshots`, `detection-flags`, `flakes`, `baselines`) and resolving a flake use snake_case keys, and every reply carries `"api_version": 1`. An error is:

```json
{ "api_version": 1, "error": { "code": "not_found", "message": "build not found" } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | a bad `status`, `limit` or `cursor` |
| 401 | `unauthorized` | a missing, wrong, expired or revoked token |
| 403 | `forbidden` | a CI token resolving a flake (only a person resolves one) |
| 404 | `not_found` | an unknown path, or an id the token cannot reach |
| 405 | `method_not_allowed` | a path that exists, with another method |
| 426 | `cli_outdated` | the CLI is older than the server takes (below) |

The upload endpoints also answer 409 (a write to a finalised build, or a finalise whose count is wrong) and 413 (a PNG over 32 MiB); their codes are `conflict` and `too_large` if a read endpoint ever needs them.

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
  "web_url": "https://<server>/projects/…/builds/…/snapshots/…"
}
```

`kind` is `missed` (a change the diff did not mark) or `false_positive` (one it marked that is not a change). `rect` is the box drawn on the shot, or `null`.

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

The plan lives in [`docs/visual-compare-map.md`](docs/visual-compare-map.md).
