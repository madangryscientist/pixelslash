# PixelSlash

Page vs design-system, vision-first — plus a pixel dashboard of Main vs Branch. Local mlx, else ollama. A standalone Bun CLI.

```
bun install
bunx playwright install chromium-headless-shell   # once, for URL capture
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

A one-pair run without a design system writes `--out/report.html` (open as `file://`): Main, Branch, Diff with the region boxes drawn over it (yellow for a change, dashed grey for noise), the changed-pixel count, the region and speck counts, and both sizes. With `--ds` or `--file`, that file is header counts, side-by-side Main/Branch shots, DS rasters, and the violation list. With `--routes`, open `--out/index.html`.

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
- `routes` are paths or objects. `name` defaults to the path's slug (`/` is `index`; a query string is slugged too, so `/search?q=a&page=2` is `search-q-a-page-2`). Top-level `masks` and `tags` apply to every route. A route `path` may carry a query string; it is sent as written and recorded as-is in the manifest's `path`.
- `storybook` shoots a Storybook without a hand-written route list. Once the app is up (after `start`), capture reads `<url>/index.json` (Storybook 7+; `docs` entries are skipped, only `type: "story"`) and adds one route per story × each combination of the listed `globals` (no globals: one per story), each then × the config's `variants`. `url` is required; `baseUrl` defaults to it, so a Storybook-only config needs no `routes`. Example:

  ```json
  { "start": { "command": "bun e2e/serve.ts", "readyUrl": "http://127.0.0.1:6007" },
    "storybook": { "url": "http://127.0.0.1:6007", "globals": { "theme": ["default", "catppuccin-mocha", "thrifty-paper"] }, "include": ["**"] } }
  ```

  - Each story is shot at `/iframe.html?id=<id>&viewMode=story&globals=<k>:<v>;…`. Its snapshot `name` is `<title>-<story name>` lower-cased and slugged, plus `@<k>=<v>` per global in the order the config lists them (`ui-primitives-card-story@theme=thrifty-paper`). The name is built from the index entry alone, so it does not change between runs; the server keys a snapshot on it. A global's name or value may not contain `:` or `;`, and a value may not repeat.
  - `include` (default `["**"]`) and `exclude` (default `[]`) are globs matched against the story id or its title; a story is shot when it matches `include` and not `exclude`. Nothing left after the filter is a config error, so a run that shoots nothing cannot pass.
  - Top-level `masks`, `tags` and `diff` apply to every story. `start.url` is not read; use `readyUrl` (it defaults to `baseUrl`, so to the Storybook's `url`).
  - Besides the usual settle, a story waits for Storybook's own signal (the preview shows `#storybook-root` with content), inside the same `timeoutMs`. A story that throws (Storybook's error display) or names no story fails the capture by name, and so does one that never renders.
  - Storybook routes and hand-written `routes` can be mixed; two that land on the same name are a config error naming both. It reads `index.json` over HTTP and never imports Storybook, so the project needs no Storybook dependency from us.
- `variants` default to one: Chromium, 1280×720, light. `theme` sets `prefers-color-scheme`. `browser` must be one the image ships — today only `chromium`.
- `masks` are **redact**: CSS selectors (every match) or rectangles in full-page CSS px (scaled by the device scale factor); both are painted `#FF00FF` before the PNG is written, so the content never leaves the machine. A selector that matches nothing prints a warning. Use it for secrets and personal data.
- `ignore` is the opposite: areas the diff skips while the real pixels stay in the PNG, so the report can hatch them over the shots. Same shapes as `masks` — CSS selectors (every match) or rectangles in full-page CSS px — and every element carrying `data-pixelslash-ignore` is one without a config entry. Selectors are resolved to boxes in the live page at screenshot time, in full-page coordinates, scaled by the device scale factor and clipped to the image; nothing is painted. A selector that matches nothing prints a warning. It is allowed at the same three levels as `diff` (top level, on a route, per variant on a route), but the layers **add up** rather than override: project + route + variant. Use it for videos, ads, maps and live data. Capture only records the boxes: the diff that skips them is the pair-mode CLI's, or the server's once uploaded.
- `diff` sets the diff tolerance a snapshot is compared with, as `{ threshold?, minChangedPixels?, minChangedRatio?, mergeDistance?, minRegionArea?, noiseAmplitude?, maxShift? }` (the same keys as the pair-mode flags; unknown keys, a threshold, ratio or amplitude outside 0 to 1, or a non-integer pixel count is a config error naming the key). It is allowed at three levels: top level (the project default), on a route, and per variant on a route as `variants: { "<variant name>": { "diff": {…} } }` (the name must be one of the config's `variants`). The most specific wins, key by key: variant > route > project > engine default. So the `/dashboard` route above compares `mobile-dark` with `minChangedPixels: 50` and `threshold: 0.02`, and every other variant of it with `threshold: 0.02` only. The resolved options are written to each manifest entry as `diff` and uploaded; a key nobody set is left out so the engine default still applies to it. The config lives in your repo, so a tolerance is reviewed and versioned with the code.
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
      "file": "pricing/desktop.png",
      "fingerprint": { "image": "version:0.1.0-dev", "browser": "chromium 148.0.7778.96", "fonts": "sha256:…" }
    }
  ]
}
```

The fingerprint says what rendered the snapshot; only snapshots with equal fingerprints are compared. `image` is `PIXELSLASH_IMAGE_DIGEST` when the run is given it (`-e PIXELSLASH_IMAGE_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' …)`), else `version:<image version>`. `fonts` hashes every font file fontconfig can see.

`diff` is the resolved diff options (`{}` when none are set; a manifest written before the field existed reads as `{}`), and `ignore` the resolved ignore boxes in image px (`[]` when none; a manifest written before the field existed reads as `[]`). Nothing in `ignore` is painted: the PNG holds the real pixels. `file` is relative to the manifest's directory and must stay inside it. See "Uploading to a server" for `--upload`.

Outside the image, `capture` still works but warns on stderr and records `image: "bare"`. Do not baseline from a bare machine: its own fonts and installs shift text and SVG rendering, and every snapshot will differ from the image's.

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

## Uploading to a server

Nothing leaves the machine unless you ask: `pixelslash upload` and `pixelslash capture --upload` are the only commands that send page shots, and they send them only to the server you name. The same CLI talks to the hosted app and to a self-hosted one.

```
pixelslash upload DIR [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N] [--config FILE]
pixelslash capture [--config FILE] [--out DIR] --upload [--server URL] [--token-path PATH] [--base BRANCH] [--branch NAME] [--pr N]
```

- `DIR` is a snapshot dir: a `manifest.json` and the PNGs it names (what `capture` writes). The whole manifest and every PNG are checked before anything is sent, so a bad dir never opens a build on the server.
- The token is a per-project CI token (`psci_…`, issued in the project's settings). It comes from `PIXELSLASH_TOKEN`, or from the file `--token-path` names. Never put it in git.
- The server is `--server`, else `PIXELSLASH_SERVER`, else `upload.server` in the config (`"upload": { "server": "https://…", "baseBranch": "main" }`; `upload` finds a config without `--config` only if one sits in the working dir, and runs fine without one).
- From the local git checkout it sends the commit, the branch, the **merge-base** with the base branch (`--base`, else `upload.baseBranch`, else `main`; `origin/<base>` is tried first) and up to **20 ancestor SHAs**, nearest first. Without the base branch in the checkout (a shallow clone) it warns and sends no merge-base: fetch full history in CI. The branch is `--branch`, else `GITHUB_HEAD_REF` / `GITHUB_REF_NAME`, else the checked-out branch; a detached `HEAD` with none of those is a usage error. The PR number is `--pr`, else read from `GITHUB_REF` (`refs/pull/N/…`).
- It opens a build, uploads each PNG, then finalises with the snapshot count; the server diffs inside that request. Exit 0 on success. Exit 1 when the server refuses (wrong or revoked token, 4xx/5xx) or cannot be reached; the build is then left open on the server, unfinalised, and its snapshots are not counted. Exit 2 on a bad flag, a missing token or server, or a bad manifest. Re-running makes a new build.

What the server stores per snapshot: `name`, `platform`, `browser`, `viewport` (`WxH`), `theme`, `tags`, the resolved diff options (`diff`, stored as JSON in `snapshots.diff_options`; a client that sends none stores `{}`), the ignore boxes (`ignore`, JSON in `snapshots.ignore`, image px; a client that sends none stores `[]`), the environment fingerprint, and the PNG under the org's prefix in the blob store (R2 on Cloudflare). The manifest's `path` and the variant's `name` are not uploaded: a snapshot is identified by name + browser + viewport + theme, so two manifest entries that differ only by variant name are refused. The manifest carries no platform; `upload` sends `linux`, which is what the pinned capture image is.

The API, for other CI integrations (`Authorization: Bearer <token>`; errors are `{"error": "…"}`):

| Request | Body | Reply |
| --- | --- | --- |
| `POST /api/v1/builds` | JSON `{ commitSha, branch, mergeBaseSha?, ancestorShas? (≤20), prNumber? }` | `201 { id }` |
| `PUT /api/v1/builds/:id/snapshots` | multipart: `meta` (JSON `{ name, platform, browser, viewport, theme, tags, diff?, ignore?, fingerprint }`), `file` (PNG, ≤32 MiB) | `200 { id }` |
| `POST /api/v1/builds/:id/finalize` | JSON `{ snapshots: N }` | `200 { id, status, error }` |

**The server diff has a ceiling.** It runs inline in the finalise request, on a Worker with a 30 s CPU limit and a 128 MB isolate (decided 2026-10-20; no Queue for beta). Measured at 1280×4000: a typical shot takes about 0.8 s, a shot where every pixel differs about 15 s. One whole-page change fits; several do not. When the diff stops itself before the limit, the build ends `errored` and `error` names the limit (`diff ceiling: measured N of M shots…`); no shot is downscaled or cropped to fit. The finalise reply still carries `200`, so read `status` and `error`. Split such a build, or diff it locally with the CLI. A hard kill by the runtime (one shot alone passing 30 s, or the isolate limit) cannot be caught in the request and can leave the build at `processing`; recovering a build stuck that way is a separate ticket.

Sending a snapshot again (same name, platform, browser, viewport, theme) replaces it. Finalising checks the server holds exactly N snapshots (409 otherwise) and closes the build: after that every write is a 409, and finalising again with the same N is a harmless retry. A token only reaches its own project's builds; another project's build id is a 404. 401 is a missing, wrong or revoked token.

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
