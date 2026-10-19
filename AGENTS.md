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

A change is green when all of these pass **from the worktree**:

```bash
bun install                       # a fresh worktree has no node_modules
bunx tsc --noEmit                 # or: bun run typecheck
bun test                          # or: bun run test
```

There is no lint step yet. Anything that changes capture, the diff or the
report also gets a real run, and the `report.html` it prints is opened and
looked at — a green `bun test` does not render a report:

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
4. **Local only.** Page shots never leave the machine. The Figma token comes
   from `FIGMA_TOKEN` or `--token-path`, never git.
5. **The CLI does not start a dev server.** Both URLs must already be up; a
   down URL fails.
6. **Figma dogfood is out of scope** (decision #62). Do not reopen 770, 771,
   772, 773, 781, 782 or 783.
