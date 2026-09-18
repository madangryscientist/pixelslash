# PixelSlash

Page vs design-system, vision-first — plus a pixel dashboard of Main vs Branch. Local mlx, else ollama. Not an `ob` command.

```
bunx nx run pixelslash:run -- (--live URL --local URL | --live-png PATH --local-png PATH | --live-png-dir DIR --local-png-dir DIR) [--ds DIR | --file FILE_KEY] [--routes FILE] [--token-path PATH] [--out DIR] [--width 1280] [--push] [--label TEXT]
```

`--live` is **Main** (prod or a main preview). `--local` is **Branch** (this worktree's preview). Both URLs must already be up — the command does not start a dev server.

`--live-png` / `--local-png` skip Playwright and use existing shots (GTK / Omnishell). `--ds` / `--file` may be omitted in this mode: PixelSlash pixel-diffs the two PNGs, stores Main + Branch + a diff overlay + a manifest (`changedPixels`, `createdAt`, optional `--label`), and exits 0. Identical shots still store a run (`changedPixels` 0). Size mismatch counts the whole frame as a change. Default `--out` is `.pixelslash`.

`--routes FILE` is one path per line (`/` `/pricing` …). `--live` and `--local` are then origins: each path is two captures + the same DS judge. `--live-png-dir` / `--local-png-dir` is the GTK form (`index.png` for `/`, `pricing.png` for `/pricing`). Writes `--out/index.html` linking each route's `report.html`. `--ds` or `--file` is required for URL and `--routes` runs.

One URL run captures both at the page width, then checks each shot against every DS component raster. Prefers `mlx_vlm.generate` when present (Mac). Else `ollama run qwen2.5vl` with the page shot, the DS raster, then the prompt (`ollama` on PATH; 100% local). PNG mode with `--ds` copies the given files into `--out` as `live.png` / `local.png` and runs the same judge. Reports violations already on Main vs NEW violations on Branch. Exit 1 if any NEW violations, else 0.

Install ollama and `ollama pull qwen2.5vl` (7b latest). Fallback if that does not fit: `ollama pull qwen2.5vl:3b && ollama cp qwen2.5vl:3b qwen2.5vl`. The CLI still spawns `qwen2.5vl`.

If both `mlx_vlm.generate` and `ollama` are missing, the HTML report still writes (shots + DS, no fake violations), stdout prints `skip: no judge`, and the process exits 0. DS-match judge is optional and is not required for Omnishell pixel runs.

HTML at `--out/report.html` (open as `file://`): header counts, side-by-side Main/Branch shots, DS rasters, violation list. With `--routes`, open `--out/index.html`.

`--push` POSTs the run to the dashboard origin in `~/.omnibus_api_url` (or `OMNIBUS_API`) with bearer `~/.ob_api_token` (or `OMNIBUS_API_TOKEN`). Auth is the existing ob API token, not a new secret. Without `--push`, write local only. The dashboard lists runs at `/pixelslash` (Personal nav) and shows Main | Branch | Diff at `/pixelslash/<id>`.

## Omnishell (GTK) dogfood

Capture two windows with grim (automation is later), then compare and push:

```
grim -g "$(slurp)" /tmp/omnishell-main.png
grim -g "$(slurp)" /tmp/omnishell-branch.png
bunx nx run pixelslash:run -- --live-png /tmp/omnishell-main.png --local-png /tmp/omnishell-branch.png --label omnishell --push
```

Open the printed URL (`https://…/pixelslash/<id>` or LAN `http://192.168.0.30:5050/pixelslash/<id>`).

Main vs a branch preview:

```
bunx nx run pixelslash:run -- --live https://example.com --local http://127.0.0.1:4173 --ds apps/pixelslash/fixtures/ds --out .pixelslash
```

Several routes (origins already up):

```
bunx nx run pixelslash:run -- --live https://example.com --local http://127.0.0.1:4173 --routes routes.txt --ds apps/pixelslash/fixtures/ds --out .pixelslash
```

GTK / Omnishell shots (no URL, no Playwright, no DS):

```
bunx nx run pixelslash:run -- --live-png main.png --local-png branch.png --out .pixelslash
```

GTK dirs + routes:

```
bunx nx run pixelslash:run -- --live-png-dir shots/main --local-png-dir shots/branch --routes routes.txt --ds apps/pixelslash/fixtures/ds --out .pixelslash
```

`--ds DIR` is in-repo fixture rasters. `--file FILE_KEY` lists Figma components, writes pngs, then the same compare loop. Token from `FIGMA_TOKEN` or `--token-path` (never git).
