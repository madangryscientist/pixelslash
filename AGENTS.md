# PixelSlash — repo conventions

A standalone Bun CLI for visual review: capture Main and Branch (Playwright, or
existing PNGs), pixel-diff them, write `report.html`, and optionally judge each
shot against a design system with a local vision model. The destination is a
Chromatic competitor that is not tied to Storybook. `docs/cli.md` is the CLI's
contract.

Extracted from omnibus on 2026-10-19 (ob 1418). History before that commit is
omnibus's.

This file is the operating agreement for contributors and agents working here:
the gate, the landing rule and the invariants. Keep it accurate. The maintainer
also keeps a private half (their ticket tracker and deploy host), which is not
in this tree.

## Tickets

`ob N` and `PS-N` are the maintainer's private ticket ids; new work cites GitHub issues.
Code comments and docs that carry one are explaining why a line exists; leave them as they are.

## The gate

The repo is a small Nx workspace on Bun workspaces:

| Project | Path | What it is |
| --- | --- | --- |
| `engine` | `packages/engine` | capture, diff, the DS judge, Figma rasters, the run store, the report |
| `cli` | `packages/cli` | the `pixelslash` bin: argv, stdout and exit codes, over `@pixelslash/engine` |
| `web` | `apps/web` | the hosted review app: TanStack Start on Cloudflare Workers, D1 via Drizzle, R2, GitHub sign-in |
| `scripts` | `scripts` | `check-slop.ts` and `write-fixtures.ts` (typecheck + lint only) |
| `bench` | `bench` | the Argos benchmark: main and held-out corpora, runner, scoring (`bun run bench`, no VM: Argos's verdicts are cached; `bun run bench:check` is the regression guard, and `bun run test` runs it too; see `bench/README.md`). The VM is needed only for `--refresh-argos` |
| `PixelSlash.Diff`, `PixelSlash.Diff.Tests` | `engines/dotnet` | the diff ported to C# behind the bench's diff contract, and its xunit tests. Inferred by `@nx/dotnet` (named after the `.csproj`); `bun run test` builds and runs them. A benchmark subject, not used by the CLI or the app |

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
bun run test                      # nx run-many -t test  (Vitest under the Bun runtime, and xunit for engines/dotnet)
```

**The .NET SDK is optional** (`engines/dotnet`, ob 1910; opt-in for contributors, PS-251). The root
scripts (`typecheck`, `lint`, `test`, `bench`, `bench:check`) go through `scripts/nx.ts`, which runs
`dotnet --version` first. Two paths:

- **With a working `dotnet`** (this desktop): nothing changes. `bun run test` builds and tests
  `PixelSlash.Diff.Tests` with xunit. The version is pinned twice, in `.tool-versions` (mise
  activates it in this directory, with no `mise trust` needed) and in `global.json` (what `dotnet`
  itself reads); `mise install` installs it. Without a `.tool-versions` here the mise shim fails with
  "dotnet ... not currently active". The first restore fetches NuGet packages, so it needs the
  network once.
- **Without one** (a container, an outside contributor): the wrapper sets `NX_DOTNET_DISABLE=true`
  and prints `dotnet SDK not found: skipping engines/dotnet`; the TS projects run as before and the
  two dotnet projects are not in the graph. A `dotnet` that cannot run (no SDK matching
  `global.json`) counts as missing. Setting `NX_DOTNET_DISABLE` yourself skips the check and the line.

The reason for the wrapper: the `@nx/dotnet` plugin in `nx.json` reads the .NET projects when Nx
builds its graph, so without an SDK **every** `nx` command fails ("Failed to register MSBuild"), not
only the dotnet ones. A bare `bunx nx ...` skips the wrapper, so on a machine without an SDK set
`NX_DOTNET_DISABLE=true` yourself. The SDK is for the gate and the bench only: it is not in the
capture image or on the self-host. A change to `engines/dotnet` needs the SDK to be checked.

One project: `bunx nx test engine`, `bunx nx lint cli`. Nx caches locally in
`.nx/`; add `--skip-nx-cache` to force a rerun. There is no Nx Cloud and no
remote cache. Lint rules are all errors; fix the code, do not disable a rule.
Tests live in `packages/*/test/` and run with `bun --bun vitest`, because the
code and tests use Bun APIs (`Bun.file`, `Bun.serve`, `Bun.spawn`).

The bench regression guard is part of `test`: `bench:test` depends on `bench:check`
(`bun bench/src/check.ts`, no VM, no browser), which fails when a score is worse than the
committed `bench/results/*.json`. The check is cacheable; its inputs are `bench/src`, the
committed corpora, `bench/results/*.json` and the engine's diff sources, so an `apps/web`
change replays it from cache. When a score moves on purpose, commit a new
`bench/results/<date>.json` in the same change: that file becomes the baseline (see
`bench/README.md`, "The regression guard").

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

## Landing: through a pull request

Code lands through pull requests: the author runs the gate above on a worktree, rebases on
`origin/main`, pushes a branch and opens a PR with the commit body as its description, and merges
it with a squash (`gh pr merge --squash --delete-branch`) once the gate is green on the rebased head.

- Do not merge a PR whose PixelSlash check is failing or pending (`gh pr checks <pr> --watch`),
  unless the PR changes nothing a shot can see and says so.
- When the land changes `apps/web` (or what it imports), deploy main from a clean checkout at
  the merged squash with `apps/web/deploy/ssh/release.sh` (`apps/web/README.md`, "Run it on the
  Proxmox server"; `apps/web/SELF-HOST.md` for your own Cloudflare account).

Scan several worktrees without opening a diff:

```bash
git log --format='%s%n%b' main..<branch>
```

Never commit implementation straight to `main`. Never `git commit -am` — stage
new files explicitly or they are silently dropped.

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

  Each of our cells also has a `commit`: the short sha of the squash on main that made its `v`
  and `note` true. A commit cannot name its own sha, so the change leaves `commit` alone and a
  follow-up commit after the squash, `docs(...): matrix rows name the <sha> land`, sets each
  changed row's `commit` to the squash's short sha and re-runs `build.py`. `build.py` stops on a
  sha `git` cannot resolve. A row whose value and note were already true before the extraction
  from the maintainer's monorepo names `06a2472` and says so in its note.
  `audited` is the date our column was last read against `ours_commit`; `updated` is the
  competitors' fetch date.
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

## Speed record: `bench/PERF.md`

`bench/PERF.md` is the running record of the diff engine's speed work: the baseline, every lever
tried and its measured effect, and the current best per page. A ticket that runs `bench:perf` for
a change updates it **in the same commit**: a run-log entry with the table, the lever's row in
the levers table, and the dashboard if the best time moved. Only compare numbers from the same
run; never mix numbers from different runs into one percentage.

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
   for (ours or self-hosted) and nowhere else. The one exception is opt-in per
   project: when a project's settings (or, for a project without its own, its
   org's) name an AI model (an OpenAI-compatible endpoint), the server sends
   that endpoint the three crops
   of each `change` region (baseline, branch and diff, cut to the region plus
   16 px) and, for the build summary, text only (shot names, counts, those
   region notes and the build's brief, the uploader's own words, when it has
   one). The brief goes to that one call and no other. It never sends a whole shot, and no other server-side call
   carries pixels. Tokens (Figma, CI upload) come from env or a token file,
   never git; a project's model key is entered in its settings and stored by
   the server. One more sink, and only when its DSN is set: **errors, never
   shots, go to the Sentry project the DSN names** (`SENTRY_DSN` on the
   server and in the browser, `PIXELSLASH_SENTRY_DSN` for the CLI). An error
   report is a message, a stack, the release and the environment; every
   report passes `scrubEvent` (`packages/engine/src/sentry-scrub.ts`), which
   drops request bodies, cookies, query strings, auth headers, tokens and
   image or blob data, and nothing attaches a PNG. With no DSN there is no
   SDK init and no outbound request. *Amended 2026-10-19: was "Local only";
   the hosted review app needs uploads. Amended 2026-10-23: the project's own
   model (ob 1473, 1668); a project without one uses its org's (ob 1789).
   Amended 2026-10-26: the error sink (PS-227). Amended 2026-10-27: the
   brief in the summary call (PS-232).*
5. **The local pair mode does not start a dev server.** `--live` / `--local`
   URLs must already be up; a down URL fails. *Amended 2026-10-19: the pinned
   capture image may start the app from a command named in its config.*
6. **Figma dogfood is out of scope** (decision #62). Do not reopen 770, 771,
   772, 773, 781, 782 or 783.
7. **`/api/v1` is a stable contract** (decided 2026-10-22). Changes are
   additive only: a new endpoint, or a new field on a reply. Nothing is
   renamed, retyped or removed, and an error `code` keeps its meaning. A
   breaking change is `/api/v2`. Every endpoint is in `ENDPOINTS`
   (`apps/web/src/api/handler.ts`) and in the "API" table of `docs/cli.md`; a test
   fails when the two differ.
