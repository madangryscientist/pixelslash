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
bun run pixelslash -- (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--label TEXT]
```

`--live` is **Main** (prod or a main preview). `--local` is **Branch** (this worktree's preview). Both URLs must already be up — the command does not start a dev server. Each capture waits for the page to settle before shooting: web fonts, every image, a short network-idle window, then two animation frames — all bounded by the capture timeout, so a page that never settles fails rather than hangs.

A URL pair may omit `--ds` and `--file`. PixelSlash captures both pages, pixel-diffs them, stores `main.png`, `branch.png`, `diff.png`, a manifest (`changedPixels`, `createdAt`, optional `--label`), and `report.html`, and exits 0. stdout points at `report.html`. Same store as PNG mode. Identical shots still store a run (`changedPixels` 0). If width or height differs, only the overlapping rectangle is diffed: `changedPixels` is that overlap count, the report states both sizes, and the non-overlap is not painted as changed. Default `--out` is `.pixelslash`.

`--live-png` / `--local-png` skip Playwright and use existing screenshots. `--ds` / `--file` may be omitted in this mode too: same pixel-diff store and `report.html`.

`--routes FILE` is one path per line (`/` `/pricing` …). `--live` and `--local` are origins. Without `--ds` or `--file`, each path is two captures, a pixel diff (`main.png`, `branch.png`, `diff.png`, manifest), and `report.html`. `--out/index.html` links those reports. Exit 0. With `--ds` or `--file`, each path is still two captures plus the DS judge. `--live-png-dir` / `--local-png-dir` is the GTK form (`index.png` for `/`, `pricing.png` for `/pricing`) and still needs `--ds` or `--file`.

With `--ds` or `--file`, one URL run captures both at the page width, then checks each shot against every DS component raster. Prefers `mlx_vlm.generate` when present (Mac). Else `ollama run qwen2.5vl` with the page shot, the DS raster, then the prompt (`ollama` on PATH; 100% local). PNG mode with `--ds` copies the given files into `--out` as `live.png` / `local.png` and runs the same judge. Reports violations already on Main vs NEW violations on Branch. Exit 1 if any NEW violations, else 0.

Install ollama and `ollama pull qwen2.5vl` (7b latest). Fallback if that does not fit: `ollama pull qwen2.5vl:3b && ollama cp qwen2.5vl:3b qwen2.5vl`. The CLI still spawns `qwen2.5vl`.

If both `mlx_vlm.generate` and `ollama` are missing, the HTML report still writes (shots + DS, no fake violations), stdout prints `skip: no judge`, and the process exits 0. DS-match judge is optional and is not required for screenshot pixel runs.

A one-pair run without a design system writes `--out/report.html` (open as `file://`): Main, Branch, Diff, the changed-pixel count, and both sizes. With `--ds` or `--file`, that file is header counts, side-by-side Main/Branch shots, DS rasters, and the violation list. With `--routes`, open `--out/index.html`.

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
  "routes": ["/", { "path": "/pricing", "name": "pricing", "masks": [".clock", { "x": 0, "y": 0, "width": 200, "height": 40 }], "tags": ["billing"] }],
  "variants": [
    { "name": "desktop", "viewport": { "width": 1280, "height": 720 } },
    { "name": "mobile-dark", "viewport": { "width": 390, "height": 844 }, "theme": "dark", "browser": "chromium" }
  ],
  "masks": ["[data-pixelslash-mask]"],
  "tags": ["web"],
  "stabilise": { "animations": true, "caret": true, "clock": "2026-01-01T00:00:00.000Z", "deviceScaleFactor": 1, "timeoutMs": 8000 }
}
```

- `baseUrl` must already be up, unless `start` is given: then the command runs first (in the container, from the working dir), its `readyUrl` (default `baseUrl`) must answer below 400 within `timeoutMs`, and the command's whole process group is stopped after the run. Its output goes to stderr.
- `routes` are paths or objects. `name` defaults to the path's slug (`/` is `index`). Top-level `masks` and `tags` apply to every route.
- `variants` default to one: Chromium, 1280×720, light. `theme` sets `prefers-color-scheme`. `browser` must be one the image ships — today only `chromium`.
- `masks` are CSS selectors (every match) or rectangles in full-page CSS px (scaled by the device scale factor); both are painted `#FF00FF`. A selector that matches nothing prints a warning.
- `stabilise` defaults: animations and transitions off (finite ones jump to their end, infinite ones reset), caret hidden, `Date.now()` / `new Date()` frozen at `clock` (`false` for the real clock), device scale factor 1. Every capture also waits for the page to settle — fonts, images, network idle, two frames — bounded by `timeoutMs`; the settle cannot be turned off.

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
      "file": "pricing/desktop.png",
      "fingerprint": { "image": "version:0.1.0-dev", "browser": "chromium 148.0.7778.96", "fonts": "sha256:…" }
    }
  ]
}
```

The fingerprint says what rendered the snapshot; only snapshots with equal fingerprints are compared. `image` is `PIXELSLASH_IMAGE_DIGEST` when the run is given it (`-e PIXELSLASH_IMAGE_DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' …)`), else `version:<image version>`. `fonts` hashes every font file fontconfig can see.

Outside the image, `capture` still works but warns on stderr and records `image: "bare"`. Do not baseline from a bare machine: its own fonts and installs shift text and SVG rendering, and every snapshot will differ from the image's.

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
