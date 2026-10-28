# Contributing to PixelSlash

Thanks for helping. This page is the short version of [`AGENTS.md`](AGENTS.md), which is the full
operating agreement for people and coding agents working here. Read it before a large change.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). A security problem goes to
[`SECURITY.md`](SECURITY.md), not to a public issue. Your contribution is licensed under
MIT, as the rest of the repo is (see [`LICENSE`](LICENSE)); there is no CLA.

## Start with an issue

For a bug, open an issue with the version, the command and the `report.html` it wrote. For
anything bigger than a fix, open an issue first so we can agree on it before you build it. The
[capability matrix](docs/capabilities/matrix.html) and the [CLI reference](docs/cli.md) say what
PixelSlash does today; a change that moves either updates it in the same pull request.

## The gate

A change is ready when all of these pass from a fresh checkout:

```bash
bun install
bun run typecheck       # tsc, strict, on every project
bun run lint            # oxlint (type-aware, --deny-warnings) and check-slop
bun run format:check    # oxfmt; `bun run format` fixes it
bun run test            # Vitest under Bun, and xunit for engines/dotnet
```

- **Lint rules are errors.** Fix the code; do not disable a rule.
- **Tests** live in `packages/*/test/`. A test that makes a temp dir removes it, and a new
  project's `vitest.config.ts` lists the `globalSetup` in `scripts/test-tmp-scope.ts` so a run
  cannot fill `/tmp`.
- **The .NET SDK is optional.** `engines/dotnet` is a C# port of the diff that the benchmark
  scores. Without a working `dotnet` the root scripts skip it and say so (`bun scripts/nx.ts` does
  the check); a change to `engines/dotnet` needs the SDK, pinned in `global.json` and `.tool-versions`.
- **The benchmark guard** (`bench:check`) is part of `test`. If a score moves on purpose, commit
  a new `bench/results/<date>.json` in the same change; see `bench/README.md`.
- **A change to `apps/web`** also runs `bunx nx build web` and `bunx nx test:e2e web`
  (Playwright, on a local D1 with GitHub stubbed).
- **A change to capture, the diff or the report** also gets a real run, and you open the
  `report.html` it writes and look at it. A green test run does not render a report:

  ```bash
  bunx playwright install chromium-headless-shell   # once per machine
  bun run pixelslash -- --live-png main.png --local-png branch.png --out out
  ```

- **Generated files are not formatted.** Anything a tool writes (the capability page, bench
  results, migrations) is listed in `.oxfmtrc.json`'s `ignorePatterns`; add a pattern when you add
  a generator.

## Rules a change must keep

These are the invariants from `AGENTS.md`. A change that breaks one is a bug, or a decision that
needs its own issue first.

1. **The report never claims more than was measured.** When shot sizes differ, only the
   overlapping rectangle is diffed and the report says so. With no judge, the run prints
   `skip: no judge` and invents no violations.
2. **Capture waits for the page to settle**, bounded by the timeout: a page that never settles
   fails; it does not hang and it does not shoot early.
3. **Exit codes are a contract.** Exit 1 only on new violations on Branch; pixel-only runs exit 0.
4. **Local unless told to upload.** Without `--upload`, page shots never leave the machine. See
   invariant 4 in `AGENTS.md` for the two opt-in exceptions and the error sink.
5. **The local pair mode does not start a dev server.**
6. **`/api/v1` is a stable contract.** Changes are additive only; a breaking change is
   `/api/v2`. Every endpoint is in `ENDPOINTS` (`apps/web/src/api/handler.ts`) and in the API
   table of [`docs/cli.md`](docs/cli.md), and a test fails when the two differ.

The CLI reference, [`docs/cli.md`](docs/cli.md), is the contract for every flag: do not drop one,
and keep `pixelslash --help` in step with it.

## Pull requests

- Branch from `main`, keep the change small, and rebase on `origin/main` before you push.
- Write the commit subject as a [Conventional Commit](https://www.conventionalcommits.org/)
  (`feat(scope): …`, `fix(scope): …`, and so on; `docs`, `chore`, `refactor`, `test`, `perf`,
  `build`, `ci`, `style`, `revert`), and say in the body why the change exists. The squash keeps
  your subject.
- Stage files by name. Never commit straight to `main`.
- Do not merge with a failing PixelSlash check unless your change touches nothing a shot can see
  and the description says so.
- Cite a GitHub issue, not a ticket id. The `ob N` and `PS-N` references in old code comments are
  the maintainer's private ticket ids; leave them as they are.
- No AI attribution trailers are required or expected: a pull request is judged on its content,
  and a commit needs no `Co-Authored-By` line for it.
