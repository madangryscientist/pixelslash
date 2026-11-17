# Testing: the four layers

PixelSlash tests at four layers (PS-15). Each layer answers one question, and a behaviour is proved at
the lowest layer that can prove it. A test at a higher layer is there only for what the lower ones
cannot see.

| Layer | Question | Runs against | Where | Command |
| --- | --- | --- | --- | --- |
| **Smoke** | Does the thing we ship start and do its one job? | the built artifact: the bundled CLI | `packages/cli/smoke` | `bunx moon run cli:smoke` |
| **E2E** | Does a user's happy path work through the real UI or CLI? | a real browser on a local build, local D1, GitHub stubbed | `apps/web/e2e`, `apps/site/e2e` | `bunx moon run web:test-e2e`, `bunx moon run site:test-e2e` |
| **Integration** | Do the parts agree with each other and with the store? | real SQLite (D1's engine), real files, real HTTP on loopback, a real child process, a local build of the web app on a local D1 | `*/test`, `apps/web/src/{db,api,diff,github,storage,server}`, `apps/web/local-build` | `bunx moon run <project>:test`, `bunx moon run web:test-local-build` |
| **Unit** | Is this function right on the cases that are easy to get wrong? | one module, no I/O | the rest of `*/test` and `apps/web/src/{lib,auth,ai}` | `bunx moon run <project>:test` |

Integration and unit share a runner (Vitest under Bun) and the `test` target, so the split between them
is by what a test touches, not by a folder. The one integration suite outside `test` is the web app's
local build (below), because it builds the app first.

A check of a local build on local data is integration, whatever its folder is called (Jacobus,
2026-11-15). Smoke is for the deployed build only; the web app has none yet. A unit test is added only for a gap: logic with branches the
layers above do not reach.

Real-browser tests run on Chromium only; Firefox and WebKit are never used in testing, at any layer,
local or CI. Every Playwright config's projects are Chromium devices (`Desktop Chrome`, `Pixel 7`), and a
phone project that ever uses an iPhone device sets `browserName: "chromium"`.

## Smoke

A smoke test runs the **released shape**, not the source: the CLI smoke imports nothing from `src/`. A
failure means the artifact is broken, not that one function is.

- **`cli`** (`packages/cli/smoke/cli.smoke.test.ts`, 4 tests, about 2 s). `moon run cli:smoke` builds
  `packages/cli/dist/index.js` and runs it as a child process, as the npm package runs: a PNG pair with
  100 changed pixels (stdout, manifest, overlay, report), an identical pair, a pair of static pages
  captured in a real browser from a loopback server, and a page that is down (exit 1, no report). The
  child's environment has every `PIXELSLASH_*` variable removed, so no token, server or error sink can
  reach it from the shell.
The CLI smoke runs the bundle on this machine, so by the rule above it is integration too; moving it is
its own change.

## The web app's local build

`apps/web/local-build` (3 files, 10 tests, about 25 s with the build). `moon run web:test-local-build`
builds the app once (`local-build/server.ts`, the Vitest `globalSetup`), applies the migrations to a
**fresh local D1** in `apps/web/.wrangler/local-build`, serves it with `vite preview` on a free port, and
runs the files one at a time against it. It runs in CI's `web` job, after the e2e. It is integration: a
local build on local data, no browser.

- `web.local-build.test.ts`: the sign-in page serves and a bad token is refused; a synthetic org's main
  and branch builds upload over `/api/v1`, the branch build reads back `changes` with a `changed`
  snapshot, and a real org's build is a 404 to it; the usage counts (below); a rerun of the seed.
- `upload.local-build.test.ts`: the real CLI from source. `upload` lands its rows and R2 objects under the
  token's org, the server's diff of a second upload, another org's token and a finalised build refused, a
  revoked token refused; `import` then `upload` of loose PNGs; a project set to diff in CI stores what the
  CLI measured; layout metrics files upload and the API read serves them.
- `stub-refusal.local-build.test.ts`: a stranger's production build (no `CLOUDFLARE_ENV`) refuses to
  start pointed at the GitHub stand-in, and starts pointed at GitHub with no Google sign-in. It builds
  its own copy and runs it in Miniflare; it does not use the server.

Each test owns its data: `seed()` (`local-build/harness.ts`) makes a user, an org, its member, a project
and a CI token with ids unique to the test, synthetic unless asked for a real org. Store writes a test
needs (a revoke, a diff location) go through the app's own store functions, not SQL.

The smoke, the local build and both e2e suites are cached like any other test: a pass replays only while every input is
the same (the whole repo minus build and test output, `bun.lock` for the Playwright build, and the env vars
each `moon.yml` lists), and a failure is never cached. A change the run could see re-runs it.

### The isolation rule, and the test that proves it

Jacobus's rule (2026-10-19): a run against a synthetic org leaves nothing a real user or a real number
can see. It governs any synthetic org: the local build's today, a smoke against a deployment later.

1. **Synthetic, and excluded from every count.** A synthetic org is an `orgs` row with `is_smoke = 1`. Every
   reader that produces a number goes through `real()` (`src/db/synthetic.ts`): `usageCounts`, the
   timings stats and the other dashboards.
2. **Idempotent.** The server starts on a state directory that is deleted first. A seed with a fixed id
   deletes that org and user before it writes them, so a re-run adds no row that survives (the local
   build's rerun test proves it).
3. **No real outbound side effects.** The build is the `CLOUDFLARE_ENV=e2e` build with every URL it can
   call (GitHub, Google, the diff sidecar, Sentry) pointed at a closed loopback port or emptied, so the
   diff runs in-process and the run reaches no host but this machine.
4. **Credentials.** Every seed issues its own random CI token; only its SHA-256 is stored. No token is in
   the repo or read from the environment.
5. **A test proves it.** The local build's usage test reads `usageCounts` before and after its own org's
   two uploads and asserts no change. The control flips `is_smoke` to 0 and asserts the counts moved by
   exactly those two builds and two snapshots, so the first assertion cannot pass merely because nothing
   was counted; flipping it back restores the first reading. The counts are deltas, so the test holds on a
   D1 other tests have written to.

### Not done: a smoke against production (needs a human)

Nothing here runs against `app.pixelslash.dev`. No path in the app creates a synthetic org, so there is
none in production. A production smoke needs steps only Jacobus can take:

1. Set `is_smoke = 1` on a dedicated prod org (a D1 `UPDATE`).
2. Issue a CI token for that org and store it as a CI secret; point the smoke at the prod URL with it.
3. Upload on a non-default branch, so retention can delete the builds, and turn retention on: R2 blobs
   for a smoke build are not removed by anything else.

## Inventory

Every test file belongs to a layer. About 215 files cannot be listed one by one here, so the inventory is
by group; a group is one layer unless a row says otherwise. Counts are from the run recorded under
"Before and after".

| Group | Files | Layer | Notes |
| --- | --- | --- | --- |
| `packages/cli/smoke` | 1 | smoke | new |
| `apps/web/local-build` | 3 | integration | the local build over HTTP and the real CLI, each test on its own org (above). Moved out of e2e: `stub-refusal.spec.ts` (no page), `upload.spec.ts` (the page only provisioned, revoked and set the diff location) and the CLI and API half of `layout-metrics.spec.ts` |
| `apps/web/e2e` | 24 specs and the sign-in setup, 48 tests with it (`playwright test --list`; 34 specs and 68 tests before the cuts below) | e2e | one happy path per feature, in a real browser (the operator health page's 404 for everyone else and the page for a listed login, `admin.spec.ts`; its empty state is a unit test, since the e2e database always has the stub's seed). Every spec starts signed in from one `setup` project and builds its org, project and CI token with `provision` (`e2e/fixtures.ts`), a write to the D1; `orgs.spec.ts` is the one test that makes them by clicking, and `admin.spec.ts`'s figures test is the one that reads the whole D1. `rss-burst.spec.ts` is a memory check and is outside the gate. `layout-metrics.spec.ts` keeps only the side panel; the diff location form is `orgs.spec.ts` |
| `apps/site/e2e` | 4 | e2e | nav, footer and dead links on the prerendered pages, desktop and phone (named `smoke.spec.ts`; it is an e2e); one header on every page and the theme toggle (`header.spec.ts`); the home page in both themes (`home.spec.ts`); the pricing page fills the column and its one action leads to the self-host guide (`pricing.spec.ts`) |
| `packages/cli/test` | 30 | integration | the `pixelslash` commands run in-process or as a child, against a fake server and real temp dirs. The `*-support.ts` files are helpers |
| `packages/engine/test` | 50 | integration + unit | store, upload, capture (real Chromium), report and DS judge are integration; `diff*`, `regions`, `fingerprint`, `sentry-scrub`, `route-names`, `change-note`, `config*` are unit |
| `apps/web/src/db` | 29 | integration | every query against real SQLite with the real migrations (`test-db.ts`, `test-d1.ts`) |
| `apps/web/src/api` | 15 | integration | the `/api/v1` handler over a real `Db` and blob store, including the `ENDPOINTS` / `docs/cli.md` agreement |
| `apps/web/src/diff` | 21 | integration | `processBuild` end to end on a real `Db`: baselines, retries, resume, timings. `wasm`, `measure`, `identical-bytes` are unit |
| `apps/web/src/github`, `storage`, `server`, `preview` | 11 | integration | the GitHub client against a local stand-in, R2-shaped blobs, the connection patch |
| `apps/web/src/lib`, `auth`, `ai` | 36 | unit | pure helpers and the model client against a fake endpoint. `use-review-keys.hook.test.tsx` renders a hook in happy-dom (its `@vitest-environment` line) to type a key in the commit that shows another shot, which no pure function can reach; `use-decision.hook.test.tsx` does the same for the decide-then-move flow, with a stubbed server call |
| `apps/web/deploy` | 7 | integration | the Docker and SSH scripts, run against temp dirs |
| `apps/site/src/content` | 3 | integration | the pages are built from the repo's own docs, so a heading or a code block cannot drift |
| `packages/playwright`, `examples/playwright-node` | 2 | integration | the Playwright integration against an upload stub |
| `bench/test` | 12 | unit | the benchmark's scoring and runner; `bench:check` is the regression guard (integration: it replays the cached Argos verdicts) |
| `engines/dotnet` | 1 project | integration | xunit, only where the .NET SDK is present |

### Duplicates cut

Each cut names where the behaviour is still proved.

| Removed | Why it was a duplicate | Still proved by |
| --- | --- | --- |
| `packages/engine/test/diff.test.ts` "identical → changedPixels 0" | the same pair as the byte-equal test, one layer lower | "byte-equal PNGs are unchanged without a decode, a diff or an overlay" (which now also asserts `antialiased` is 0) |
| `packages/engine/test/diff.test.ts` "one pixel differs" | a one-pixel case of the counting the region tests and the smoke's 100-pixel pair assert | `regions.test.ts`, the other `diffPngs` cases, and `cli.smoke.test.ts` (100 changed pixels, exact) |
| `apps/web/src/diff/process-recovery.test.ts` "a build the Worker ceiling stopped is resumed on retry, and the retry gives the verdict" | the resume path and the verdict-on-retry path are each tested alone | `process-resume.test.ts` (resume) and "a diff that errored is re-diffed to a real verdict" in the same file |
| `apps/web/src/api/handler.test.ts`, the `GET /api/v1/nope` 404 line | the same refusal is asserted for the other unknown path and method in the same test | the remaining assertions of "unknown paths and methods are refused" |
| `apps/web/e2e/deep-history.spec.ts` (the whole file, one test) | a browserless upload test dressed as an e2e; nothing it asserts is in the UI | `process-deep-history.test.ts` (a main build 150 commits back is the baseline, a newer one is not used, the nearest wins, past 200 ancestors the shot is new) and `packages/engine/test/upload.test.ts` (the CLI sends up to 200 first-parent ancestors) |
| `apps/web/e2e/timings.spec.ts` "with several builds the Timings tab counts them and keeps the slowest as max" | the arithmetic is the stats module's, not the tab's | `timings-stats.test.ts` ("lists every project with p50/p95 of its builds"); the tab itself was rendered by the first test in that file, which is cut too (see "E2E specs cut" below) |
| `apps/web/e2e/metrics.spec.ts` "a build older than the timings says so, and invents no zero" | it clears columns in D1 to test one rendering rule | `src/lib/run-card.test.ts` ("has no wall time, no compare time and no re-capture line", "never shows a time it did not record as 0") for the build card; `src/lib/run-metrics.test.ts` ("is absent for a shot never timed") and `src/lib/branch-metrics.test.ts` (an untimed shot is left out, not counted as 0) for the shot and branch pages |

Nothing proved before is unproved now: each row above names a surviving test that fails if the behaviour
breaks.

### E2E specs cut

Eight web specs and three tests in two others were each a data and logic check run through a browser.
Every assertion moved to the lowest layer that can prove it, or is looks only (theme, phone width). The
page wiring that a browser used to prove is now a render test: `renderToStaticMarkup` for components
with no router, and `src/test/render-routed.tsx` (a memory-history router) for components with a link.
A component that is clicked or typed into is rendered in happy-dom with Testing Library through
`src/test/render.tsx`: the app's router at a memory history around it, and, for a route, the server
functions it calls bound to a fresh `testDb()` store signed in as a seeded user (the file's header shows
the three `vi.mock` lines). A `createServerFn` does not run its validator or return its handler's result
outside the Start compiler, so each server function a route test binds is split into its validator and
a plain function of the store, the viewer and the input, which the server function wraps
(`src/server/twin-fns.ts` is the first). Such a test runs the component and the handlers, not the HTTP
hop between them, which only the e2e suite exercises.
The count goes from 34 spec files and 68 tests to 26 and 51 (`bunx playwright test --list` in `apps/web`).

| Removed | Still proved by |
| --- | --- |
| `composition.spec.ts` (2 tests) | `components/composition.test.tsx` (the overlay, the findings line, the focus), `components/shot-card.test.tsx` (the card carries the line), `api/composition.test.ts` ("the build view hands stored findings to the screens") |
| `carried-from-main.spec.ts` | `diff/process-open-vs-main.test.ts` and `process-open-vs-main-page.test.ts` (what is carried and how it is filed), `lib/summary-counts.test.ts` (the counts line), `lib/review-walk.test.ts` (the j/k walk) |
| `metrics.spec.ts` | `components/run-metrics.test.tsx` (build card, shot and branch pages), plus the unit tests already named in the table above |
| `timings.spec.ts` (4 tests) | `components/build-timings.test.tsx`, `components/org-timings.test.tsx`, `lib/timings.test.ts`, `db/timings-stats.test.ts`; theme and phone width are looks only, and the click that opens the Timings tab, its `?tab=timings` URL and the loader are walked by `orgs.spec.ts`, which gained a step for it |
| `brief.spec.ts` | `components/build-brief.test.tsx`, `components/brief-summary.test.tsx` |
| `native.spec.ts` | `diff/process-native.test.ts`, `components/snapshot-side-panel.test.tsx`, `api/native.test.ts`, `packages/cli/test/import-native.test.ts` |
| `parity.spec.ts` (3 tests) | `components/parity-view.test.tsx`, `components/twins.test.tsx`, `api/parity.test.ts`, `api/twins.test.ts` |
| `stale.spec.ts` | `components/stale.test.tsx`, `components/twins.test.tsx`, `db/stale.test.ts`, `db/stale-review.test.ts`, `api/stale.test.ts`, `diff/process-stale.test.ts`; accepting a stale shot is walked by `review.spec.ts` |
| `ai-review.spec.ts` "a build with 10 changed shots gets no summary, says why, and offers no Regenerate" and "with no model a changed shot is reviewed as plain pixels" | `components/build-summary.test.tsx`, `components/ai-notes.test.tsx`, `diff/process.test.ts` |
| `twins.spec.ts` "a build shows its twin and links to it" | `components/twins.test.tsx`, `db/twins.test.ts`, `api/twins.test.ts` |
| `twins.spec.ts` "the project settings link a twin project of the same org, and clear it" (the file is gone) | `components/twin-settings.test.tsx` (no options alone in an org; pick, save, held after the loader re-runs; None clears it, which the spec's title claimed and never tested; a refused save in the alert), with `getTwinOptions` and `saveTwinProject` running against a temp store; `db/twins-linked.test.ts` (the link rule, and `twinCandidates`). The HTTP hop to a server function is still walked by the other settings specs |

Kept, with the reason: the other two tests in `ai-review.spec.ts` (an opted-in project's model auto-passes a
noise-only shot; a project without its own model uses the org's) need the settings forms, their server
functions and the stub model pipeline together, which no render test reaches.

The two merges planned beside this cut: `admin-health-now.test.ts` is folded into `admin-health.test.ts`
(its fixtures moved to `admin-health-kit.ts` so the file stays under the 300-line lint cap).
`ai/summary-parse.test.ts` stays its own file: `summary.test.ts` is at the cap, and merging would break it.

### Gaps filled

- **No test ran the shipped CLI.** Everything in `packages/cli/test` imports `src/`; a broken bundle (a
  missing `diff.wasm`, a bad shebang, a dependency that did not bundle) passed the gate. `cli:smoke` is
  that test.
- **No test ran the production build of the web app without a browser.** `web:test-local-build` does,
  and is the first test to state the isolation rule above as an assertion.

### Considered and left

- The `api` and `db` groups overlap in places (a rule asserted at the query and again at the endpoint).
  They are cheap, run in milliseconds, and fail in different places; they were not cut.

## Before and after

Measured on the desktop, `--skip-nx-cache`, the same machine in the same session.

| Layer | Project | Files | Tests | Time |
| --- | --- | --- | --- | --- |
| Smoke | `cli` | 0 → 1 | 0 → 4 | n/a → 2 s (the CLI build is cached) |
| Smoke | `web` | 0 → 1 | 0 → 4 | n/a → 17 s (build, migrate, serve, drive; now the local-build integration suite) |
| E2E | `web` (Playwright, 1 worker) | 24 → 23 | 39 → 36 (38 + 1 skipped → 35 + 1 skipped) | 164 s → 154 s |
| Integration + unit | `engine` | 47 → 47 | 584 → 582 (580 pass + 2 skipped) | 20.1 s → 18.8 s |
| Integration + unit | `cli` | 29 → 29 | 214 → 214 | 31.0 s → 30.7 s |
| Integration + unit | `web` | 96 → 96 | 666 → 665 | 44.1 s → 40.1 s |
| Integration + unit | `bench` | 12 → 12 | 148 → 148 | 11.5 s → 11.3 s |

The `site` e2e (1 spec) and the `.NET` xunit project were not touched and not re-measured. Integration and
unit tests share one Vitest run per project, so they are reported together; the split in the inventory is
by group. The differences of a second or two in untouched projects (`cli`, `bench`) are the noise of the
run, so read them as "unchanged". The tests cut are 2 in `engine`, 1 in `web` and 3 e2e; the layers
gain 8 smoke tests.

That table is the four-layer cut's own record. The web e2e has moved since: today it is 24 specs and the
sign-in setup, 48 tests (`playwright test --list`), and the local build is 3 files and 10 tests.

## Running them

```bash
bunx moon run cli:smoke              # builds the CLI first
bunx moon run web:test-local-build   # builds the web app and starts it on a fresh local D1
bunx moon run web:test-e2e     # the happy paths in a real browser
bunx moon run <project>:test   # integration + unit
```

In CI the web e2e runs every spec once on the production build (with the diff in the sidecar). A second run
on `vite dev` is cut to `e2e/review.spec.ts`: it exists so the pngjs diff inside workerd, as on Cloudflare,
stays under an e2e run, and that spec makes the server diff and reads its result. The CLI's uploads diff in
workerd too, on the production build with no sidecar, in the local-build step that follows. The site's e2e runs the `desktop` project only (not the phone one), and only when the site
itself changed (`apps/site/` or what decides how it installs) or on `main`; a docs-only edit is checked by
`moon run site:build` (a dead internal link or a missing `cli.md` anchor fails the prerender) and the site's unit
tests, and a spec that quotes a docs sentence waits for the next site change or the push to `main`.

The local build's state is `apps/web/.wrangler/local-build` (gitignored), recreated on every run; its scratch is under
`TMPDIR`, which `scripts/test-tmp-scope.ts` scopes and removes.
