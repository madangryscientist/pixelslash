# Testing: the four layers

PixelSlash tests at four layers (PS-15). Each layer answers one question, and a behaviour is proved at
the lowest layer that can prove it. A test at a higher layer is there only for what the lower ones
cannot see.

| Layer | Question | Runs against | Where | Command |
| --- | --- | --- | --- | --- |
| **Smoke** | Does the thing we ship start and do its one job? | the built artifact: the bundled CLI, a production build of the web app | `packages/cli/smoke`, `apps/web/smoke` | `bunx nx smoke cli`, `bunx nx smoke web` |
| **E2E** | Does a user's happy path work through the real UI or CLI? | a real browser on a local build, local D1, GitHub stubbed | `apps/web/e2e`, `apps/site/e2e` | `bunx nx test:e2e web`, `bunx nx test:e2e site` |
| **Integration** | Do the parts agree with each other and with the store? | real SQLite (D1's engine), real files, real HTTP on loopback, a real child process | `*/test`, `apps/web/src/{db,api,diff,github,storage,server}` | `bunx nx test <project>` |
| **Unit** | Is this function right on the cases that are easy to get wrong? | one module, no I/O | the rest of `*/test` and `apps/web/src/{lib,auth,ai}` | `bunx nx test <project>` |

Integration and unit share a runner (Vitest under Bun) and the `test` target, so the split between them
is by what a test touches, not by a folder. A unit test is added only for a gap: logic with branches the
layers above do not reach.

## Smoke

A smoke test runs the **released shape**, not the source: the CLI smoke imports nothing from `src/`, and
the web smoke talks to the built server over HTTP (its one `src/` import is the `usageCounts` query, to
read the numbers a dashboard would show). A failure means the artifact is broken, not that one function is.

- **`cli`** (`packages/cli/smoke/cli.smoke.test.ts`, 4 tests, about 2 s). `nx smoke cli` builds
  `packages/cli/dist/index.js` and runs it as a child process, as the npm package runs: a PNG pair with
  100 changed pixels (stdout, manifest, overlay, report), an identical pair, a pair of static pages
  captured in a real browser from a loopback server, and a page that is down (exit 1, no report). The
  child's environment has every `PIXELSLASH_*` variable removed, so no token, server or error sink can
  reach it from the shell.
- **`web`** (`apps/web/smoke/web.smoke.test.ts`, 4 tests, about 17 s). `nx smoke web` builds the app,
  applies the migrations to a **fresh local D1** in `apps/web/.wrangler/smoke`, serves it with
  `vite preview`, and drives the `/api/v1` upload of a main build and a branch build over HTTP: the
  sign-in page serves, a bad token is refused, a token reads `/me`, the pair uploads and the branch build
  reads back `changes` with a `changed` snapshot, and another org's build is a 404.

Neither smoke is cacheable (`cache: false`): a smoke that replays from cache proves nothing.

### The isolation rule, and the test that proves it

Jacobus's rule (2026-10-19): a smoke run leaves nothing a real user or a real number can see.

1. **Synthetic, and excluded from every count.** The smoke org is an `orgs` row with `is_smoke = 1`. Every
   reader that produces a number goes through `real()` (`src/db/synthetic.ts`): `usageCounts`, the
   timings stats and the other dashboards.
2. **Idempotent.** The server starts on a state directory that is deleted first. The smoke org, user and
   project have fixed ids and are deleted and re-inserted on every run, so a re-run (the fourth test) adds
   no row that survives.
3. **No real outbound side effects.** The build is the `CLOUDFLARE_ENV=e2e` build with every URL it can
   call (GitHub, Google, the diff sidecar, Sentry) pointed at a closed loopback port or emptied, so the
   diff runs in-process and the run reaches no host but this machine.
4. **Credentials.** The smoke token is `PIXELSLASH_SMOKE_TOKEN` when set (a secret store or CI secret,
   which a later production smoke would use) and otherwise a random one made for the run; only its SHA-256 is stored. No token is in the repo.
5. **A test proves it.** `web.smoke.test.ts` seeds one **real** org with one build and one snapshot, runs
   the smoke uploads, and asserts `usageCounts` is still `{ builds: 1, snapshots: 1 }`. The control flips
   `is_smoke` to 0 and asserts the same counts become `{ 3, 3 }`, so the first assertion cannot pass
   merely because nothing was counted; flipping it back restores `{ 1, 1 }`.

### Not done: a smoke against production (needs a human)

The smoke is **local D1 only**, by the ticket. No path in the app creates a smoke org, so there is none in
production, and nothing here runs against `app.pixelslash.dev`. If a production smoke is wanted, it needs
steps only Jacobus can take:

1. Set `is_smoke = 1` on a dedicated prod org (a D1 `UPDATE`, as `web.smoke.test.ts` does locally).
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
| `apps/web/smoke` | 1 | smoke | new |
| `apps/web/e2e` | 26 (was 25) | e2e | one happy path per feature, in a real browser (the operator health page's 404 for everyone else and the page for a listed login, `admin.spec.ts`; its empty state is a unit test, since the e2e database always has the stub's seed). `rss-burst.spec.ts` is a memory check and is outside the gate; `stub-refusal.spec.ts` checks the build kind, which is a build-level test; the CLI-driven specs in `upload.spec.ts` are integration-shaped but need the real build, so they stay here |
| `apps/site/e2e` | 4 | e2e | nav, footer and dead links on the prerendered pages, desktop and phone (named `smoke.spec.ts`; it is an e2e); one header on every page and the theme toggle (`header.spec.ts`); the home page in both themes (`home.spec.ts`); the pricing page fills the column and its one action leads to the self-host guide (`pricing.spec.ts`) |
| `packages/cli/test` | 30 | integration | the `pixelslash` commands run in-process or as a child, against a fake server and real temp dirs. The `*-support.ts` files are helpers |
| `packages/engine/test` | 50 | integration + unit | store, upload, capture (real Chromium), report and DS judge are integration; `diff*`, `regions`, `fingerprint`, `sentry-scrub`, `route-names`, `change-note`, `config*` are unit |
| `apps/web/src/db` | 20 | integration | every query against real SQLite with the real migrations (`test-db.ts`, `test-d1.ts`) |
| `apps/web/src/api` | 15 | integration | the `/api/v1` handler over a real `Db` and blob store, including the `ENDPOINTS` / `docs/cli.md` agreement |
| `apps/web/src/diff` | 21 | integration | `processBuild` end to end on a real `Db`: baselines, retries, resume, timings. `wasm`, `measure`, `identical-bytes` are unit |
| `apps/web/src/github`, `storage`, `server`, `preview` | 11 | integration | the GitHub client against a local stand-in, R2-shaped blobs, the connection patch |
| `apps/web/src/lib`, `auth`, `ai` | 29 | unit | pure helpers and the model client against a fake endpoint |
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
| `apps/web/e2e/timings.spec.ts` "with several builds the Timings tab counts them and keeps the slowest as max" | the arithmetic is the stats module's, not the tab's | `timings-stats.test.ts` ("lists every project with p50/p95 of its builds"); the tab itself is still rendered by the first test in the file |
| `apps/web/e2e/metrics.spec.ts` "a build older than the timings says so, and invents no zero" | it clears columns in D1 to test one rendering rule | `src/lib/run-card.test.ts` ("has no wall time, no compare time and no re-capture line", "never shows a time it did not record as 0") for the build card; `src/lib/run-metrics.test.ts` ("is absent for a shot never timed") and `src/lib/branch-metrics.test.ts` (an untimed shot is left out, not counted as 0) for the shot and branch pages |

Nothing proved before is unproved now: each row above names a surviving test that fails if the behaviour
breaks.

### Gaps filled

- **No test ran the shipped CLI.** Everything in `packages/cli/test` imports `src/`; a broken bundle (a
  missing `diff.wasm`, a bad shebang, a dependency that did not bundle) passed the gate. `cli:smoke` is
  that test.
- **No test ran the production build of the web app without a browser.** `web:smoke` does, and is the
  first test to state the isolation rule above as an assertion.

### Considered and left

- `upload.spec.ts` drives the CLI against the real build and could be an integration test; it also proves
  the build serves the upload API the CLI really calls, so it stays an e2e.
- The `api` and `db` groups overlap in places (a rule asserted at the query and again at the endpoint).
  They are cheap, run in milliseconds, and fail in different places; they were not cut.

## Before and after

Measured on the desktop, `--skip-nx-cache`, the same machine in the same session.

| Layer | Project | Files | Tests | Time |
| --- | --- | --- | --- | --- |
| Smoke | `cli` | 0 → 1 | 0 → 4 | – → 2 s (the CLI build is cached) |
| Smoke | `web` | 0 → 1 | 0 → 4 | – → 17 s (build, migrate, serve, drive) |
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

## Running them

```bash
bunx nx smoke cli          # builds the CLI first
bunx nx smoke web          # builds the web app and starts it on a fresh local D1
bunx nx test:e2e web       # the happy paths in a real browser
bunx nx test <project>     # integration + unit
```

The smoke state is `apps/web/.wrangler/smoke` (gitignored), recreated on every run; its scratch is under
`TMPDIR`, which `scripts/test-tmp-scope.ts` scopes and removes.
