# PixelSlash — repo conventions

A standalone Bun CLI for visual review: capture Main and Branch (Playwright, or
existing PNGs), pixel-diff them, write `report.html`, and optionally judge each
shot against a design system with a local vision model. The destination is a
Chromatic competitor that is not tied to Storybook. `README.md` is the CLI's
contract; `docs/visual-compare-map.md` holds the product direction and
decisions.

Extracted from omnibus on 2026-10-19 (ob 1418). History before that commit is
omnibus's.

This file is the operating agreement for agents working here. The `ob-planner`
skill reads it in Step 0 to learn this repo's tracker, gate and landing
convention — keep it accurate or the planner will adapt to a stale repo.

## Tracker: `ob` only

The repo has a remote — `origin`, `github.com/madangryscientist/pixelslash`,
**private** — and `gh` is authenticated, so `gh issue` would work. We do not
use it: one tracker is better than two, and `ob` is where the planning,
spinoff and landing workflow lives. Do not create GitHub issues unless a human
asks for them.

- Tickets live in `ob`, project **`pixelslash`**. Create with
  `ob add "<title>" --project pixelslash --body "<brief>"`.
- The parent is Visual Compare (ob 649). Refer to tickets **by name**, not bare
  ids, in anything a human reads.
- Put the brief in the item's **body**. `ob spinoff brief` reads
  `wayfinder/tickets/<ref>-*.md` only in omnibus; here there is no such
  directory, so the brief falls back to the item's title + body. That fallback
  is the mechanism — use it.

Write each brief with these three headings, because the builder's launch
prompt is built from them:

```
## What to build
## Acceptance
## Do not
```

`## Do not` is where you fence scope: files out of bounds, things that must not
be refactored, "do not add a dependency for this".

## The gate

The repo is a small Nx workspace on Bun workspaces:

| Project | Path | What it is |
| --- | --- | --- |
| `engine` | `packages/engine` | capture, diff, the DS judge, Figma rasters, the run store, the report |
| `cli` | `packages/cli` | the `pixelslash` bin: argv, stdout and exit codes, over `@pixelslash/engine` |
| `web` | `apps/web` | the hosted review app: TanStack Start on Cloudflare Workers, D1 via Drizzle, R2, GitHub sign-in |
| `scripts` | `scripts` | `check-slop.ts` and `write-fixtures.ts` (typecheck + lint only) |
| `bench` | `bench` | the Argos benchmark: main and held-out corpora, runner, scoring (`bun run bench`, no VM: Argos's verdicts are cached; `bun run bench:check` is the regression guard; see `bench/README.md`). The VM is needed only for `--refresh-argos` |

`bunfig.toml` sets `[install] linker = "isolated"`: a package sees its own
declared dependencies and the root's, not another package's. Declare what a
package imports in that package's `package.json`; do not lean on a sibling's.
The capture image copies only the package manifests, never the bunfig, so it
still installs hoisted; its PNG hashes matched main's when this landed.

A change is green when all of these pass **from the worktree**:

```bash
bun install                       # FIRST: a fresh worktree has no node_modules, and nx stops with
                                  # "Could not find Nx modules" until it is installed
bun run typecheck                 # nx run-many -t typecheck  (tsc, strict)
bun run lint                      # nx run-many -t lint  (oxlint --type-aware --deny-warnings + check-slop)
bun run format:check              # oxfmt --check  (`bun run format` fixes)
bun run test                      # nx run-many -t test  (Vitest under the Bun runtime)
```

One project: `bunx nx test engine`, `bunx nx lint cli`. Nx caches locally in
`.nx/`; add `--skip-nx-cache` to force a rerun. There is no Nx Cloud and no
remote cache. Lint rules are all errors; fix the code, do not disable a rule.
Tests live in `packages/*/test/` and run with `bun --bun vitest`, because the
code and tests use Bun APIs (`Bun.file`, `Bun.serve`, `Bun.spawn`).

**Generated files are not formatted.** `oxfmt` rewrites what it is given, so anything a tool
writes must be excluded in `.oxfmtrc.json`'s `ignorePatterns` rather than hand-formatted: the
capability page (`docs/capabilities/*.html`), the bench fixtures, results and Argos cache, the
route tree, `worker-configuration.d.ts` and the drizzle migrations. They are already listed —
add a pattern when a new generator appears, or `format:check` will fail on a file whose content
the next run of its generator overwrites. Sources (`data.json`, `build.py`, `bench/src`,
`scripts`) are formatted normally: a generated file is ignored, its input is not. `**/*.md` is
ignored too, so prose is never reflowed by a formatter.

**/tmp is a quota'd tmpfs; do not fill it.** A full /tmp fails unrelated tests with
`Disk quota exceeded` / `SQLITE_IOERR`. Two rules keep it empty:

- Every project's test run goes through `scripts/test-tmp-scope.ts` (a Vitest and
  Playwright `globalSetup`): `TMPDIR` is a fresh dir for the run and is removed after it,
  so anything a test or the code under it leaves in the temp dir goes with the run. A test
  that makes its own temp dir still removes it in `afterAll`/`finally`; a new project's
  `vitest.config.ts` must list the same `globalSetup`. Check a new test with
  `ls -A /tmp | sort` before and after `bun run test --skip-nx-cache`.
- `nx.json` sets `"useDaemonProcess": false`. With the daemon on, every non-CI `nx` run
  made the daemon install `nx@latest` into `/tmp/tmp-<pid>-*/` (~97 MB) to check for
  outdated AI-agent config, and a stopped daemon did not remove it. Do not turn the daemon
  back on, and do not run `nx daemon` here.

A change to `apps/web` also runs the standard's web gate (from the worktree root):

```bash
bunx nx build web
bunx nx test:e2e web              # Playwright: a local build on a fresh local D1, GitHub stubbed
(cd apps/web && bun run test:e2e:dev)   # the same specs against `vite dev` (after the build run: same ports)
(cd apps/web && bunx wrangler deploy --dry-run --outdir /tmp/ps-web-dry)
```

`apps/web` keeps its schema in `src/db/schema.ts`; `bun run db:generate` (in
`apps/web`) writes the next additive migration to `apps/web/drizzle/`. All
queries go through `src/db/*` (they take a `Db`, never D1), and blobs through
`orgBlobs` in `src/storage/blobs.ts`, so a Docker self-host can swap both.

Anything that changes capture, the diff or the report also gets a real run,
and the `report.html` it prints is opened and looked at — a green test run
does not render a report:

```bash
bunx playwright install chromium-headless-shell   # once per machine
bun run pixelslash -- --live-png <main.png> --local-png <branch.png> --out /tmp/ps-check
```

## Landing: no PRs

Implementation lands on a branch, the builder commits with a trailing
`State:` line, and the planner gates and squash-merges with `ob-land`.

1. Builder commits on its own branch, ending the message with one of
   `State: ready` / `State: needs-human` / `State: blocked` / `State: partial`.
2. The builder never pushes and never merges.
3. On `State: ready`, the planner loads `ob-land` and lands it. Landing is what
   touches the remote, and it is the only step that does:

   ```bash
   git push origin main
   git push origin --delete <branch>   # only after the squash is on main
   ```

Scan several worktrees without opening a diff:

```bash
git log --format='%s%n%b' main..<branch>
```

Never commit implementation straight to `main`. Never `git commit -am` — stage
new files explicitly or they are silently dropped. The repo stays private.

## Dispatch

`ob spinoff <ref>` enqueues a launch; the daemon drains it in-session. Dispatch
is always interactive and `--agent` is a usage error.

`ob config` routes `spinoff_launcher_by_repo` → `pixelslash: t3`, so a spinoff
opens a **T3 Code thread** in this repo's T3 project (`pixelslash`, workspace
root `~/dev/pixelslash`), bound to the ob-owned worktree. A fresh spinoff
worktree has no `node_modules`; `bun install` is the builder's first step.

The planner itself is the pinned T3 thread `planner · pixelslash`, created by
`ob t3 planner --repo pixelslash` (idempotent: a re-run reads the same thread
back and creates nothing).

## The ob planner

Everything for driving this repo through `ob` from opencode lives in
`.opencode/`:

| Path | What it is |
| --- | --- |
| `agents/planner.md` | The planning agent. Primary mode, subagents denied. Overrides the global `planner` for this repo only. |
| `commands/ob-planner.md` | `/ob-planner` — primes a session as the planner. Overrides the global command here. |
| `SOUL.md` | Injected into every request by `ob-soul`. Keep it short; it costs tokens on every turn. |
| `plugins/*.ts` | One-line re-exports of ob's four runtime plugins (see below). |

These are the opencode fallback; the planner is the pinned T3 thread. There is
no launcher script here (thrifty's `planner-tui.sh` was not copied), and the
`ob-planner` skill sets `disable-model-invocation`, so `/ob-planner` alone cannot
load it — an opencode planner session needs the skill injected over
`POST /api/experimental/session/{id}/skill`.

The plugins give a session the `ob agents` heartbeat, always-on memory, SOUL
injection and the skill-filing nudge. They are re-exported from the omnibus
checkout by **absolute** path: a relative path breaks from a T3 worktree, and a
`plugins` entry in `opencode.jsonc` that names files rather than a directory
loads nothing, silently. After touching any of this, confirm all four load:

```bash
opencode api get "/api/plugin?location%5Bdirectory%5D=$PWD" \
  | python3 -c "import json,sys; print([p['id'] for p in json.load(sys.stdin)['data'] if p['id'].startswith('ob-')])"
```

The skills need no wiring here — the global config registers `omnibus/skills`,
so `ob-cli`, `ob-spinoff`, `ob-land`, `ob-skeptical-review` and the rest resolve.

## Capability matrix — `docs/capabilities/`

`docs/capabilities/matrix.html` is the standing answer to "what does this do, against the field":
a capability table with our column and five public tools. `data.json` is the source; `build.py`
renders the page (no dependencies, `python3 docs/capabilities/build.py`); the HTML is committed so
it opens as `file://` without a build step.

**It is kept current as we go, not written once.** Two triggers:

- **A landing changes what we can do** — a new diff kind, a new flow step, an acceptance that no
  longer needs a human, a threshold that moves. That is the same commit: edit our row's `v` and
  `note` in `data.json`, clear its `plan` when the ticket lands, re-run `build.py`, commit the
  regenerated `matrix.html` with it. A row that says "open: ob N" after N has landed is a lie
  with a ticket number on it.
- **A positioning or pricing decision is about to be made** — refresh the competitor columns
  (1422, 1425, 1426). Fetch each vendor's docs again, update `updated`, and keep the per-cell
  notes: they are what makes a `partial` arguable rather than a guess.

The honesty rules are the same as the report's:

1. Our column is read from the code at `ours_commit`. A `y` means it exists in the code and the
   gate exercises it where there is a test — never "we specified it". `build.py` refuses nothing,
   so this is on the author.
2. A competitor cell comes from a page actually fetched, with the date in `updated`. Not from
   memory, not generalised from another vendor. `?` means the docs did not say; it is never
   evidence of absence and never renders as a gap we can sell.
3. `behind` is computed, not curated: a row is behind when our value scores below the best
   competitor's. Do not hand-tune it to make the number smaller.
4. Do not add a row for something no tool has, to flatter the count. The page states plainly
   that nothing we have is unique; if that changes, it is because a landing changed it, and the
   landing updates the text.

## Repo invariants

1. **The report never claims more than was measured.** When shot sizes differ,
   only the overlapping rectangle is diffed and the report states both sizes;
   the non-overlap is not painted as changed. With no judge available the run
   prints `skip: no judge` and invents no violations.
2. **Capture waits for the page to settle** (fonts, images, network idle, two
   frames), bounded by the timeout — a page that never settles fails, it does
   not hang and it does not shoot early.
3. **Exit codes are a contract.** Exit 1 only on NEW violations on Branch;
   pixel-only runs exit 0. CI will read this.
4. **Local unless told to upload.** Without `--upload`, page shots never leave
   the machine. With it, they go only to the server the project is configured
   for (ours or self-hosted) and nowhere else. Tokens (Figma, CI upload, model
   keys) come from env or a token file, never git. *Amended 2026-10-19: was
   "Local only"; the hosted review app needs uploads.*
5. **The local pair mode does not start a dev server.** `--live` / `--local`
   URLs must already be up; a down URL fails. *Amended 2026-10-19: the pinned
   capture image may start the app from a command named in its config.*
6. **Figma dogfood is out of scope** (decision #62). Do not reopen 770, 771,
   772, 773, 781, 782 or 783.
