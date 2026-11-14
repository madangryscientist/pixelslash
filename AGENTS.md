# PixelSlash: repo conventions

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

The repo is a small moon workspace (moon 2.6.5, `@moonrepo/cli` pinned in `package.json`) on Bun
workspaces. `.moon/workspace.yml` lists the projects, each has a `moon.yml`, and `.moon/tasks/*.yml`
holds what they inherit:

| Project | Path | What it is |
| --- | --- | --- |
| `engine` | `packages/engine` | capture, diff, the DS judge, Figma rasters, the run store, the report |
| `cli` | `packages/cli` | the `pixelslash` bin: argv, stdout and exit codes, over `@hackcove/pixelslash-engine` |
| `web` | `apps/web` | the hosted review app: TanStack Start on Cloudflare Workers, D1 via Drizzle, R2, GitHub sign-in |
| `site` | `apps/site` | pixelslash.dev: TanStack Start on a Worker, every page prerendered from the repo's own docs and `data.json`; no D1, R2 or sign-in. The planner deploys it after a merge (`apps/site/README.md`) |
| `scripts` | `scripts` | `check-slop.ts`, `check-dashes.ts` and `write-fixtures.ts`; typecheck, lint and the test of `check-dashes.ts` |
| `bench` | `bench` | the Argos benchmark: main and held-out corpora, runner, scoring (`bun run bench`, no VM: Argos's verdicts are cached; `bun run bench:check` is the regression guard, and `bun run test` runs it too; see `bench/README.md`). The VM is needed only for `--refresh-argos` |
| `dotnet` | `engines/dotnet` | the diff ported to C# behind the bench's diff contract (`PixelSlash.Diff`), and its xunit tests (`PixelSlash.Diff.Tests`): two `.csproj` files, one moon project, tagged `dotnet`. `bun run test` builds and runs them. A benchmark subject, not used by the CLI or the app |

`bunfig.toml` sets `[install] linker = "isolated"`: a package sees its own
declared dependencies and the root's, not another package's. Declare what a
package imports in that package's `package.json`; do not lean on a sibling's.
The capture image copies only the package manifests, never the bunfig, so it
still installs hoisted; its PNG hashes matched main's when the linker landed.
`bunfig.toml` also sets `[install] globalStore = true`: most packages in `node_modules`
are symlinks into one shared store under the Bun cache, not per-worktree
copies. `globalStore = false` is the project-wide fallback.

A change is green when all of these pass **from the worktree**:

```bash
bun install                       # FIRST: a fresh worktree has no node_modules, and so no moon
bun run typecheck                 # moon run --concurrency 3 :typecheck  (tsc, strict)
bun run lint                      # moon run --concurrency 3 :lint  (oxlint --type-aware --deny-warnings + check-slop;
                                  # check-dashes fails on an em or en dash in any tracked text file)
bun run format:check              # oxfmt --check  (`bun run format` fixes)
bun run test                      # moon run --concurrency 3 :test  (Vitest under the Bun runtime, and xunit for engines/dotnet)
```

**The .NET SDK is optional** (`engines/dotnet`, ob 1910; opt-in for contributors, PS-251). The root
scripts (`typecheck`, `lint`, `test`, `bench`, `bench:check`) go through `scripts/moon.ts`, which runs
`dotnet --version` first. Two paths:

- **With a working `dotnet`** (this desktop): nothing changes. `bun run test` builds and tests
  `PixelSlash.Diff.Tests` with xunit. The version is pinned twice, in `.tool-versions` (mise
  activates it in this directory, with no `mise trust` needed) and in `global.json` (what `dotnet`
  itself reads); `mise install` installs it. Without a `.tool-versions` here the mise shim fails with
  "dotnet ... not currently active". The first restore fetches NuGet packages, so it needs the
  network once.
- **Without one** (a container, an outside contributor): the wrapper prints
  `dotnet SDK not found: skipping engines/dotnet` and adds `--query "tag!=dotnet"` to `moon run`, so
  the TS projects run as before and the `dotnet` project does not. A `dotnet` that cannot run (no SDK
  matching `global.json`) counts as missing. This path does not fail in CI either: the SDK is
  optional. Setting `PIXELSLASH_DOTNET_DISABLE` (any value) yourself skips the check and the line,
  and leaves the project out.

The reason for the wrapper: moon's graph needs no SDK, so every moon command works without one, but
`moon run :test` runs every project's `test`, and `dotnet:test` fails where there is no `dotnet`. A
bare `bunx moon run :test` skips the wrapper, so on a machine without an SDK add
`--query "tag!=dotnet"` yourself, or run one project. The wrapper also puts the root's
`node_modules/.bin` on PATH, which moon does not. The SDK is for the gate and the bench only: it is
not in the capture image or on the self-host. A change to `engines/dotnet` needs the SDK to be checked.

One project: `bunx moon run engine:test`, `bunx moon run cli:lint`. A task id cannot hold a colon, so
the Playwright suites are `test-e2e` (`bunx moon run web:test-e2e`). moon caches locally in
`.moon/cache` (gitignored); add `--force` to force a rerun. moon has no `^default`: every task in a
TypeScript project (tag `ts`, `.moon/tasks/ts.yml`) hashes all of `packages/**`, and every task
hashes the root files in `.moon/tasks/all.yml`, so a change to the engine re-runs everything that
imports it. Cache correctness over granularity. moon runs without a toolchain (no
`.moon/toolchains.yml`, `pipeline.installDependencies: false`), so it never downloads Bun or runs
`bun install`. moon diffs the head against `main` before any task runs, so every CI job that runs
moon fetches the full history and sets `MOON_BASE=origin/main`. There is no remote cache: the gate
job keeps `.moon/cache` between runs with `actions/cache`, keyed on ref and sha, falling back to the
same ref and then to `main`.
GitHub scopes a PR's cache to that PR, so a branch cannot poison `main`'s, and a tag (a release)
neither restores nor saves it. Lint rules are all errors; fix the code, do not disable a rule.
Tests live in `packages/*/test/` and run with `bun --bun vitest`, because the
code and tests use Bun APIs (`Bun.file`, `Bun.serve`, `Bun.spawn`).
Real-browser tests run Chromium only; set `PIXELSLASH_TEST_BROWSERS=firefox,webkit` (or `all`) to add the others, and a browser named there that does not launch fails the run.

The bench regression guard is part of `test`: `bench:test` depends on `bench:check`
(`bun bench/src/check.ts`, no VM, no browser), which fails when a score is worse than the
committed `bench/results/*.json`. The check is cacheable; its inputs are `bench/src`, the
committed corpora, `bench/results/*.json`, the engine's diff sources and the inherited ones
(`packages/**` and the root files), so an `apps/web` change replays it from cache. When a score moves on purpose, commit a new
`bench/results/<date>.json` in the same change: that file becomes the baseline (see
`bench/README.md`, "The regression guard").

**Generated files are not formatted.** `oxfmt` rewrites what it is given, so anything a tool
writes must be excluded in `.oxfmtrc.json`'s `ignorePatterns` rather than hand-formatted: the
capability page (`docs/capabilities/*.html`), the bench fixtures, results and Argos cache, the
route tree, `worker-configuration.d.ts` and the drizzle migrations. They are already listed:
add a pattern when a new generator appears, or `format:check` will fail on a file whose content
the next run of its generator overwrites. Sources (`data.json`, `build.py`, `bench/src`,
`scripts`) are formatted normally: a generated file is ignored, its input is not. `**/*.md` is
ignored too, so prose is never reflowed by a formatter.

**/tmp is a quota'd tmpfs; do not fill it.** A full /tmp fails unrelated tests with
`Disk quota exceeded` / `SQLITE_IOERR`. One rule keeps it empty:

- Every project's test run goes through `scripts/test-tmp-scope.ts` (a Vitest and
  Playwright `globalSetup`): `TMPDIR` is a fresh dir for the run and is removed after it,
  so anything a test or the code under it leaves in the temp dir goes with the run. A test
  that makes its own temp dir still removes it in `afterAll`/`finally`; a new project's
  `vitest.config.ts` must list the same `globalSetup`. Check a new test with
  `ls -A /tmp | sort` before and after `bun run test -- --force`.

A change to `apps/web` also runs the standard's web gate (from the worktree root):

```bash
bunx moon run web:build
bunx moon run web:test-e2e        # Playwright: a local build on a fresh local D1, GitHub stubbed
(cd apps/web && bun run test:e2e:dev -- e2e/upload.spec.ts e2e/review.spec.ts)   # the two specs that make the server diff, against `vite dev` (after the build run: same ports)
(cd apps/web && bunx wrangler deploy --dry-run --outdir /tmp/ps-web-dry)
(cd apps/web && CLOUDFLARE_ENV=production bun run build && bunx wrangler deploy --dry-run --outdir "$TMPDIR/ps-web-dry-production")   # env.production, app.pixelslash.dev (PS-277)
```

**Tests have four layers** (smoke, e2e, integration, unit; `docs/testing.md` is the policy, the
inventory and the before/after). A behaviour is proved at the lowest layer that can prove it, and a
new unit test is for a gap, not a second copy. The two smoke targets run the *built* artifact and are
not part of `test` (they build, they are never cached, and `web` needs a local build and a port):

```bash
bunx moon run cli:smoke           # builds packages/cli/dist, then runs it as a child process
bunx moon run web:smoke           # builds the web app, a fresh local D1 in .wrangler/smoke, drives /api/v1
```

A smoke run is **local only** and leaves no number behind: the web smoke's org is `is_smoke`, a test
proves `usageCounts` is unchanged by it, and there is no production smoke (`docs/testing.md`).
Run both after a change to the CLI's bundle (`scripts/build-cli.ts`, its dependencies) or to the web
build, the upload API or the synthetic-org filter (`src/db/synthetic.ts`).

A change to `apps/site`, or to a file it renders (`docs/cli.md`, `apps/web/SELF-HOST.md`,
`SECURITY.md`, `docs/capabilities/data.json`, the README's trademark line), runs:

```bash
bunx moon run site:build
bunx moon run site:test-e2e       # Playwright on the build, desktop and phone: nav, footer, no dead links (CI: `-- --project desktop`)
(cd apps/site && bunx wrangler deploy --dry-run --outdir "$TMPDIR/ps-site-dry")
```

CI runs `Site gate (build, e2e)` in two tiers. The build (`bunx moon run site:build`) runs on a pull request that
touches `apps/site/`, `docs/`, a root file the site renders or installs from (`README.md`, `SECURITY.md`,
`apps/web/SELF-HOST.md`, `apps/web/github-app/manifest.json`, `package.json`, `.moon/`,
`tsconfig.base.json`, `bun.lock`, `bunfig.toml`, `scripts/test-tmp-scope.ts`) or `ci.yml`, and on every push to
`main`. The build prerenders with `crawlLinks` and `failOnError`, and `resolve-links.ts` throws on a missing
`cli.md` anchor, so a docs-only edit is checked by the build and the site's unit tests, not a browser. The e2e
(`bunx moon run site:test-e2e -- --project desktop`, the phone project is not run in CI) runs only on the short list:
`apps/site/`, `scripts/test-tmp-scope.ts`, `package.json`, `.moon/`, `tsconfig.base.json`, `bun.lock`,
`bunfig.toml` and `ci.yml`, and on every push to `main`. A tag (a release) runs neither. The check is not
required, so a skipped job blocks nothing; the hand run above is no longer the only run, but the wrangler dry
run stays yours. The `web` and `site` jobs install no .NET SDK and run only web and site tasks; only `gate` has it.

`apps/web` keeps its schema in `src/db/schema.ts`; `bun run db:generate` (in
`apps/web`) writes the next additive migration to `apps/web/drizzle/`. All
queries go through `src/db/*` (they take a `Db`, never D1), and blobs through
`orgBlobs` in `src/storage/blobs.ts`, so a Docker self-host can swap both.

Anything that changes capture, the diff or the report also gets a real run,
and the `report.html` it prints is opened and looked at: a green test run
does not render a report:

```bash
bunx playwright install chromium-headless-shell   # once per machine
bun run pixelslash -- --live-png <main.png> --local-png <branch.png> --out /tmp/ps-check
```

## Flaky tests come first

A flaky test (one that fails and then passes on the same code, here or in CI) is the project's highest
priority from the moment it is seen. It costs every PR and every run on `main` until it is gone, so it is
not left for later.

- File it at once, with the failing output and the run it came from, and fix it before any other work
  starts. Work already in flight finishes; nothing new is picked up ahead of it.
- Fixed means the cause is found from a reproduction and the test, or the code under it, is corrected. No
  retry, no bigger timeout, no skip or quarantine.
- Until the fix lands, a PR whose only failure is that known flake may be rerun. It is not merged past it
  without the maintainer's go for that PR.

## Commits: conventional, as in Hack Cove

Every commit is `<type>(<scope>): <subject>`, as in `fix(engine): diff only the overlap when sizes
differ`: branch commits, PR titles and the squash commit on `main` alike. The squash subject is what
`main`'s history and the changelog are read from, so merge with `gh pr merge <pr> --squash --subject "…"`
when the PR title is not already in this form.

- **The scope is the area, never a ticket:** `cli`, `engine`, `playwright`, `web`, `site`, `bench`,
  `scripts`, `ci`, `release`, `deps`. A change across several areas takes the one it is mostly about;
  repo-wide docs and config may drop the scope (`docs: …`, `chore: …`).
- **Only a GitHub issue goes in the subject**, at the end, in parentheses: `feat(web): re-run
  errored shots (#12)`. The maintainer's private ids (`PS-N`, `ob N`) stay out of new branch names,
  commit messages, PR titles and PR bodies. GitHub appends the PR number on a squash; leave it.
- **The type is honest:** `feat`, `fix` and `perf` change what a user gets and belong in the
  changelog; `docs`, `test`, `chore`, `refactor`, `build`, `ci` and `style` do not. A `!` after the
  type (`feat(cli)!: …`), or a `BREAKING CHANGE:` footer, marks a break in the CLI contract
  (`docs/cli.md`: flags, stdout, exit codes) or in the upload API.
- A release is `chore(release): @hackcove/pixelslash <version>`.
- No commit, PR title or PR body carries a `Co-Authored-By` or any other AI attribution line.

Older subjects on `main` carry a private ticket, as the scope (`feat(PS-289): …`, `feat(ob 1421): …`)
or at the end (`… (PS-395)`); leave them, and do not copy either form.

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

Never commit implementation straight to `main`. Never `git commit -am`: stage
new files explicitly or they are silently dropped.

## Capability matrix: `docs/capabilities/`

`docs/capabilities/matrix.html` is the standing answer to "what does this do, against the field":
a capability table with our column and five public tools. `data.json` is the source; `build.py`
renders the page (no dependencies, `python3 docs/capabilities/build.py`); the HTML is committed so
it opens as `file://` without a build step.

**It is kept current as we go, not written once.** Two triggers:

- **A landing changes what we can do**: a new diff kind, a new flow step, an acceptance that no
  longer needs a human, a threshold that moves. That is the same commit: edit our row's `v` and
  `note` in `data.json`, clear its `plan` when the ticket lands, re-run `build.py`, commit the
  regenerated `matrix.html` with it. A row that says "open: ob N" after N has landed is a lie
  with a ticket number on it.

  Each of our cells also has a `commit`: the short sha of the squash on main that made its `v`
  and `note` true. A commit cannot name its own sha, so the change leaves `commit` alone and a
  follow-up commit after the squash, `docs(...): matrix rows name the <sha> land`, sets each
  changed row's `commit` to the squash's short sha and re-runs `build.py`. `build.py` stops on a
  sha `git` cannot resolve. A row whose value and note were already true in the public root
  names that root's sha (`2082085`).
  `audited` is the date our column was last read against `ours_commit`; `updated` is the
  competitors' fetch date.
- **A positioning or pricing decision is about to be made**: refresh the competitor columns
  (1422, 1425, 1426). Fetch each vendor's docs again, update `updated`, and keep the per-cell
  notes: they are what makes a `partial` arguable rather than a guess.

The honesty rules are the same as the report's:

1. Our column is read from the code at `ours_commit`. A `y` means it exists in the code and the
   gate exercises it where there is a test, never "we specified it". `build.py` refuses nothing,
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

Speed runs are on demand only. Never add `bench:perf` to the gate, a land or a timer: a dev machine
is always busy with something else, so an unasked run gives noisy numbers. When one is asked for,
run base against head, interleaved, in one invocation, on one machine. The accuracy guard
(`bench:check`) is a different thing and stays in the gate.

Every speed measurement runs inside the dedicated reservation, never on the shared machine and never by
waiting for the load to drop. `bench:perf` takes it as a flag, `--env dedicated`, which needs `--impl`:
the default `--env none`, and a ref comparison, are shared runs. Any other timed command (`bench:native`,
a ref comparison, a capture at several worker counts, an upload timing) runs from one script that starts
with `sudo -n /usr/local/sbin/pixelslash-bench-reserve on --pid $$` (CPUs `4,5,10,11` and `4G` by
default) and traps `sudo -n /usr/local/sbin/pixelslash-bench-reserve off` on exit. A new `bench/PERF.md`
entry says `dedicated`. If the helper is not installed, or refuses the run, no measurement is taken and
none is recorded: never fall back to a shared run. The reservation squeezes everything else on the
machine and lapses after 30 minutes unless `renew` is run, so it is for timing runs only, never a repro
or a test loop. `bench/README.md` ("A quiet machine") has the details.

## Rivals are benchmarks

Do not copy, adapt or vendor code from an open-source competitor, even when its licence allows it.
Measure against a rival through its own public interface, as `bench` does with Argos, and beat it on
our own code. Do not offer "borrow their X" as an option.

## The repo is public

Every commit, branch and PR is published as soon as it is pushed. Keep secrets, LAN addresses, home
paths, ticket internals and commercial plans out of all of them. Prefer permissive or public-domain
dependencies.

## Repo invariants

1. **The report never claims more than was measured.** When shot sizes differ,
   only the overlapping rectangle is diffed and the report states both sizes;
   the non-overlap is not painted as changed. With no judge available the run
   prints `skip: no judge` and invents no violations.
2. **Capture waits for the page to settle** (fonts, images, no request in flight, two
   frames; the Playwright helper keeps `networkidle`), bounded by the timeout: a page that never settles fails, it does
   not hang and it does not shoot early.
3. **Exit codes are a contract.** Exit 1 on NEW violations on Branch, or when the
   run itself failed (a capture, Figma, the dev lock, a refused upload); pixel-only
   runs that complete exit 0; a crash is 7, never 1. CI will read this.
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
