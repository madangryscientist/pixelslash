# Docs gap against Chromatic, page by page (PS-315)

Audit of our text documentation against Chromatic's public docs. It produces the page lists for
PS-316 (getting started and tutorials), PS-317 (concepts, troubleshooting, FAQ) and PS-318 (the CLI
reference: task-first, searchable). It writes no docs pages itself.

## Sources and method

**Chromatic, fetched 2026-11-05.** Chromatic publishes its docs for machines, so the whole set was
read as text rather than page by page in a browser:

- the index, <https://www.chromatic.com/docs/llms.txt> (231 pages, each with a one-line summary);
- the full text, <https://chromatic.com/docs/llms-full.txt> (about 168,000 words), which carries the
  same pages as the per-page files `https://chromatic.com/docs/llms/<slug>.txt`.

The pages that were read in full for the comparisons below: Quickstart, Why Chromatic, CI (index),
GitHub Actions, Branches and baselines, Threshold, Ignore elements, Flake filter, Review, the FAQ
index and a sample of the 110 FAQ articles. The rest were read for their headings and summaries,
which is enough to map a topic and not enough to judge its prose; the judgements on Chromatic's
writing quality are limited to the pages named here.

**Ours, at commit `5d319e3`.** Every statement about our docs was checked against the files:
`docs/getting-started.md` (401 words), `docs/cli.md` (27,366 words), `docs/metrics.md`,
`apps/web/SELF-HOST.md`, `README.md`, `apps/site/src/content/docs-map.ts`,
`apps/site/src/components/pages/docs.tsx`, `apps/site/src/content/links.ts`, the engine and CLI
sources for error strings and exit codes, and `.github/workflows`. The getting-started commands were
also run for real on a pair of local PNGs: they work, exit 0, and print the lines the page shows.

Nothing of Chromatic's text is copied here. The page titles and URLs are cited as sources, and the
comparisons are in our words.

## The two products are shaped differently

This decides what "a gap" means.

| | Chromatic | PixelSlash |
| --- | --- | --- |
| Where it runs | Hosted cloud; your Storybook is built and sent to them | Local first: a CLI, a pinned capture image, an optional review app you self-host |
| What it starts from | Storybook stories (also Playwright, Cypress, Vitest, React Native) | Any URL, PNGs you already have, Playwright tests, Storybook via its `index.json`, native screenshots (Maestro) |
| Who reviews | Teams in their web app, with PR checks | The local `report.html`; the review app only if you run one |
| Extras | TurboSnap, Figma, accessibility and interaction tests, SSO, billing | Design-system judge, web/native parity, an MCP server for coding agents |

A reader of Chromatic's docs learns to sign up, install an addon and let a hosted service do the
rest. A reader of ours installs a CLI and decides where each piece runs. Our docs therefore need
more explanation of *choices* (which capture route, which CI shape, where the diff runs) and less of
account administration.

## Topic map

Chromatic's 231 pages grouped by the topics its sidebar uses, against what we have. "Page" means a
page on the docs site (`docs-map.ts`, 19 pages) or a standalone file.

| Chromatic topic (pages) | Our counterpart | Verdict |
| --- | --- | --- |
| Why Chromatic, Quickstart (2; the Quickstart is about 3,300 words with seven numbered steps) | `docs/getting-started.md` (401 words; install, compare two URLs, compare two PNGs, open the report) | **Thin.** Right commands, no real output shown, no screenshots, no route choice, no first review, no CI step. |
| Visual tests: snapshots, viewports, themes, modes, delay, animations, fonts, hover and focus, media features, position sticky, resource loading (about 20) | `cli.md` "Snapshot capture" (4,274 words in one H2: config JSON, variants, `setup`, `masks`, `ignore`, `stabilise`, `flaky`) | **Complete in the contract, unfindable as a topic.** The settings exist; no page says "fix a font that loads late" or "stop an animation" as a task. |
| Threshold, anti-aliasing (1) | `cli.md` "Tuning the diff" (434 words) and "How the diff works" (337) | **Ours is more precise, but explains no decision.** The flag table is right; nothing says when to change it. |
| Ignore elements, flake filter, unstable tests, quarantine, page shift detection (5) | `--ignore` (cli.md:109), `ignore` and `masks` in the capture config, flaky policy (cli.md:~755) and `pixelslash flakes` / `flake` (cli.md:793) | **Complete, scattered over four places.** The flake policy sits inside the 7,622-word upload section. |
| Branches and baselines (1; about 4,000 words) | The baseline rules are in the upload section ("rule 2"); `compare` has no baseline, it takes two sides | **Missing as a concept page.** The rules are written for the server's implementer, not a reader. |
| Review: UI Review, diff inspector, discussions, checklists, reviewers, PR checks, permalinks (about 8) | The report (cli.md "The report", 144 words) and, for a server, "Reading builds" and "Block CI on review" | **Local report: thin. Hosted review: not applicable while `APP_LIVE` is false.** |
| CI: GitHub Actions, GitLab, CircleCI, Jenkins, Azure, Bitbucket, Travis, Semaphore, custom (9 pages, about 21,800 words together) | One generic shell snippet in "Block CI on review" (cli.md:858) | **The largest single gap.** We say "the same on any CI" and show none. |
| Storybook setup, addon, decorators, params, composition, publish, `isChromatic`, mocking (about 20) | `init --storybook`, the `storybook` config key, the `pixelslash-once` and `pixelslash-flaky-*` tags (cli.md "Start a repo", "Snapshot capture") | **Works, no tutorial.** There is no page that starts from a Storybook and ends at a review. |
| Playwright, Cypress, Vitest, React Native (about 15) | "Snapshots from your own Playwright tests" (648 words), `examples/playwright-node` | **Playwright: documented, but the page and the example README still say the package is unpublished.** Cypress, Vitest, React Native: no counterpart (see "Does not apply"). |
| TurboSnap (9 pages, about 16,400 words) | none | **Does not apply as such** (it reads Storybook's build graph). The need behind it, "do not shoot what did not change", is answered by `--only`, `dev` and `check`, and has no page. |
| Accessibility, interaction tests (7) | "Accessibility checks: violations that are new on Branch" (cli.md:337) | **One subsection, no usage page.** |
| Monorepos, Nx, configuration, CLI, parameters, webhooks, Slack, browsers (about 10) | "A monorepo: one org token" (cli.md:871), the flag lines in each section | **No CLI reference page and no configuration reference page.** Flags live inside prose. |
| API, OAuth clients | "API" (cli.md, 2,613 words), plus the `ENDPOINTS` test that keeps it complete | **Ours is strong.** See "Where ours is clearer". |
| Access control, billing, notifications, usage, open-source sponsorship, legal (about 15) | `SECURITY.md`, `apps/web/SELF-HOST.md` | **Does not apply** while there is no hosted account. |
| FAQ (110 articles, about 16,500 words) | none | **Missing.** There is no FAQ and no troubleshooting page, and the docs never mention Chromatic. |
| Support, onboarding guide (2) | the repo's issues | Not a docs page. |

Our own map has eight groups and 19 pages: Get started (3), Capture (4), The diff and report (3),
Design-system judge (1), Review server and CI (2), While you build (1), Agents (1), Reference (4).
`docs/getting-started.md` and `docs/metrics.md` are the only pages that are their own files; the
other 17 are cuts of `docs/cli.md`. The word counts per H2 in `cli.md`: Install 124, Compare 429,
How the diff works 337, Tuning 434, Judge 521, Report 144, Step timings 1,104, init 292, Capture
4,274, Playwright 648, PNGs 2,893, Compare dirs 594, Feature mode 1,338, Signing in 2,185, MCP 1,512,
Uploading 7,622, API 2,613, GTK 187.

## Tasks a reader can do at Chromatic and not here

Each row names what to write and for which ticket. "N/A (app)" means it needs the hosted app, which
is gated off (`APP_LIVE=false`, `apps/site/src/content/links.ts`); "N/A (product)" means the product
differs; the rest are gaps we can close.

### Get going

- Follow one numbered path from nothing to a first reviewed change, with the output of each step.
  *PS-316.*
- Set up from a Storybook: find the stories, shoot them, tag one to be shot once or marked flaky.
  The support exists (`storybook` config key, `init --storybook`, tags checked by
  `packages/engine/src/storybook.ts`). *PS-316.*
- Set up from a Playwright suite and run it on plain Node. The package is published
  (`@hackcove/pixelslash-playwright` 0.1.0, 2026-11-04) and `examples/playwright-node` is a working
  project. *PS-316.*
- Set up from a plain list of URLs with `--routes`, light and dark, two viewports. *PS-316.*
- Add PixelSlash to CI on GitHub Actions, GitLab, CircleCI, Jenkins and others, and gate the job on
  the result. *PS-316.* Only claim what the code supports: exit 1 is reserved for new design-system
  violations and pixel-only runs exit 0 (invariant 3), so a CI gate without a server is a script over
  `--json`, and a gate on review needs the review server (`status --wait`, exits 4 and 5). Both
  shapes need running for real before they are written.
- Pin the CLI version and the capture image in CI. *PS-316.*

### Understand it

- What a baseline is, and how one is chosen. Locally there is none: you give Main and Branch. On a
  server the baseline comes from the merge-base and its ancestors, with a rule for a shot a branch
  has not seen. *PS-317.*
- What a threshold is, what anti-aliasing and sub-pixel shift do to a count, and when to move each of
  `--threshold`, `minChangedPixels` and `minChangedRatio`. *PS-317.*
- When to ignore an area (`--ignore`, `ignore`, `[data-pixelslash-ignore]`) and when to redact it
  (`masks`). The difference matters: an ignored box is not compared, a redacted one is painted over
  in the stored shot. *PS-317.*
- What makes a shot flaky, what `flaky: "review"` and `"skip"` do, and how to reproduce one with
  `pixelslash flake ID`. *PS-317.*
- What settling means (fonts, images, network idle, two frames), how a page that never settles
  fails, and which stabilise settings stop animation, clock and font drift. *PS-317.*
- Read a report: what changed, new and removed mean, what a region is and what a speck is.
  *PS-317.*
- What the exit codes mean for a script (0 to 8), what the `FAILED` line is and what to do on a 7.
  *PS-317 explains it, PS-318 puts the table where it is found.*

### Fix it

- Look up an error message and get the cause and the fix. We have about 177 `UsageError` and
  `CaptureError` throw sites across 51 source files and no page that lists one. *PS-317.*
- Find out why every shot is "new", why two environments will not compare (fingerprints), why a
  story did not render, why a build is stuck waiting. *PS-317.*
- Debug a failing capture: run the one route with `--only`, read the `FAILED` line, find the report.
  *PS-317.*

### Move and choose

- Migrate from Chromatic: what maps to what (a story is a route or a story entry, a baseline is a
  branch, a PR check is an exit code), what has no equivalent. *PS-317 (FAQ).*
- Compare with Percy, Applitools and Chromatic honestly. `docs/capabilities/` already holds a
  sourced matrix, so the page links to it and restates nothing. *PS-317 (FAQ).*

### Find it

- Search the docs. There is none on the site. *PS-318.*
- Reach the next and previous page. Done already: `PrevNext` in `docs.tsx` (test ids
  `docs-prev-next`, `docs-prev`, `docs-next`) is built on `neighbours()` in `docs-map.ts`. PS-318 asks
  for it again; only its wording and its coverage of the new pages need checking. *PS-318.*
- Read one command's flags without reading the surrounding essay. *PS-318.*

### Does not apply while `APP_LIVE` is false (hosted app, list only, document none)

- Sign up, create a project, invite a team, assign reviewers, roles, teams, SSO, billing, plans,
  notifications, Slack, webhooks, OAuth clients.
- Review a build in the hosted web UI: the diff inspector, discussions, accept and reject, the PR
  check posted by the hosted app, permalinks, the UI checklist.
- Hosted-app steps in the existing docs: every "in the project's settings" instruction in `cli.md`
  (diff location, thresholds set in the review UI, ignore boxes drawn in the review UI, Flakes list,
  org tokens). Where these sit in a page a reader must meet, the new page says "on a server you run
  yourself" and links to `/self-host`, and says nothing of `app.pixelslash.dev`.

### Does not apply because the product differs

- TurboSnap and its trace utility: they read Storybook's webpack or Vite graph. Our equivalent need
  is covered by `--only`, `dev` and `check`.
- Cypress, Vitest and React Native setup. We have no integration for them. Native screenshots enter
  by PNG, through Maestro (cli.md:411).
- Figma in Chromatic and the Storybook Figma plugin: out of scope (invariant 6, decision 62). Do not
  write about it.
- Publishing a Storybook for others to view, embedding stories, composition and the Storybook MCP:
  we do not host Storybooks.
- Account pages (profile, email, password, username, delete account), billing and usage reports,
  legal pages, snapshot quotas and plan limits.
- Interaction tests: not a visual-test feature we offer.

## Where ours is clearer

These are real, and the new pages should keep them rather than copy Chromatic's shape.

- **The exit codes say who is at fault.** Chromatic's CLI page also has an exit-code table (14
  codes with keys, from `OK` to `GIT_OUT_OF_DATE`, and a flag to exit 0 on changes), so a table is
  not the advantage. Ours says which codes a runner may retry, and that 7 is a bug in pixelslash and
  never your page or your config (cli.md:586 to 595, 620). Note the cost: Chromatic's exit 1 *is*
  "the build has changes", so a CI job gates on it with no server; ours reserves 1 for new
  design-system violations and exits 0 on pixel-only changes (invariant 3). That is a product
  difference the CI pages must state in their first lines, not hide.
- **It states what it will not do.** Local unless told to upload; no dev server started by `compare`
  or `check`; the non-overlap of two shots of different sizes is not painted as changed
  (invariants 1, 4 and 5). None of the Chromatic pages read states the equivalent of "nothing
  leaves your machine", which for them cannot be true.
- **The API is complete and tested.** The `API` section lists every endpoint with its body and
  reply, and a test fails when the list and `ENDPOINTS` differ. Chromatic's API page is about 4,000
  words of its own; the difference is the guarantee, not the length.
- **Commands are shown with the real output line.** `pixelslash: N changed, N unchanged, N new,
  N removed` is documented byte for byte so a script can parse it (cli.md:492), and the
  getting-started output matched a real run.
- **Honest limits.** "Known gap", "a build never claims a verdict on a shot it did not measure"
  and the fingerprint rule say where the tool stops. This is also the voice we want in the FAQ.
- **The capability matrix** (`docs/capabilities/matrix.html`) is a sourced, dated comparison with
  five tools, where Chromatic's FAQ has one article on how it differs from Percy and Applitools.
- **Self-hosting is documented step by step** (`SELF-HOST.md`, steps 1 to 10, plus "on your own
  box"). None of the Chromatic pages read describes running the service yourself.
- **Agents are a first-class reader.** The MCP page and the JSON output of each command have no
  Chromatic counterpart.
- **One file is the contract, and the site cannot drift from it.** `docs.test.tsx` fails when an H2
  of `cli.md` is on no page or on two.

## Judgement

Five axes, each scored against what Chromatic's pages show, with the evidence.

### Accuracy: mostly right, with three faults to fix

The commands in `getting-started.md` ran for real and printed what the page says. The exit-code
table and the `FAILED` line match the code. Three statements are wrong or misleading at this commit:

1. **"Not published yet" is stale.** `cli.md:358` says `@hackcove/pixelslash-playwright` is
   "packed with `bun scripts/pack-npm.ts`, not published yet". It was published as 0.1.0 on
   2026-11-04 (`npm view @hackcove/pixelslash-playwright`), and `@hackcove/pixelslash` is at 0.7.0.
   `examples/playwright-node/README.md` has the same claim ("Neither is on npm yet").
2. **"Only equal fingerprints are compared" is unqualified.** It appears at `cli.md:308`, `380` and
   `407`. It is true on a server (a differing shot is `rebaseline_needed`, cli.md:834) and false for
   `compare` and `check`, which warn by name and diff anyway (cli.md:491 and 901, and the
   `compareSnapshots` comment). A reader of the capture page gets the wrong rule for their local run.
3. **`getting-started.md` omits two files** a run writes into the out dir (`live.png`, `local.png`)
   next to the report.

Ticket references in the contract (17 of the form `ob 1948`, `PS-228`) are explanatory for the
maintainer and are kept by the repo rule; they do not belong in the pages a reader meets, so the new
pages carry none.

### Completeness: the facts are there, the topics are not

Almost everything a user needs is in `cli.md`. What is missing is the *shape* of a docs site:
no FAQ, no troubleshooting, no per-CI page, no concepts, no migration page, no tutorial per route.
Chromatic has 110 FAQ articles; we have none, and no page mentions Chromatic at all, so a reader
arriving from "Chromatic alternative" finds no bridge.

### Findability: the weakest axis

- The site has no search (nothing in `apps/site/src` implements one).
- One H2 is 7,622 words (Uploading), another 4,274 (Capture), another 2,893 (PNGs). A reader looking
  for the flake policy must scroll through the upload essay.
- The flake policy, the baseline rules and the exit codes are each in a different long section, and
  none has a page named for the question.
- Error text is not searchable as a page, because no page lists it.
- Done well already: a docs nav in eight groups, an "On this page" contents list, prev and next
  links, and test-ids for them.

### Examples: present, but too few and not run end to end

The Playwright and `init` pages have working snippets. The capture config has a JSON example. There
is no worked example per route, no CI file, no screenshot of a report beyond the one image
(`docs/images/report.png`), and the getting-started page shows no output block for the report step.
Chromatic's quickstart has a screenshot at nearly every step; for us a screenshot of
`report.html` at each step is cheap, since we make them ourselves.

### Plain language: precise, but written for the implementer

The reference is readable in its first lines and then turns into change-log prose: "a carrier whose
build is still diffing when the change is decided", "the pick", "finalise", "rule 2", "the carry".
Seven lines run past 1,200 characters. Terms are used before they are defined (baseline, carry,
fingerprint, floors, specks). Chromatic's pages are plainer: short headings, a sentence on what a
page is for, then the steps. The fix is not to shorten the contract; it is to put a plain page in
front of each topic and link down to the contract.

## The page lists

Every page below is written for a reader, runs its commands for real before they go in, shows real
output, and cites no ticket. A page that needs a server says "on a server you run yourself" and
links to `/self-host`; none mentions `app.pixelslash.dev` while `APP_LIVE` is false.

### PS-316: getting started and tutorials

A new group "Tutorials" in `docs-map.ts`, placed after Get started. Each page stands as its own
file under `docs/` (the site's `file` field), not as a cut of `cli.md`.

1. **Getting started** (rewrite of `docs/getting-started.md`, from 401 words to about 1,000): install
   and check the version; compare two URLs; open the report and read it (one screenshot, with its
   regions labelled); change one thing and run again; what exit code to expect; where to go next
   by route. Keep every existing command, which was verified.
2. **Choose how to capture**: one decision page comparing URLs and `--routes`, a Storybook, your own
   Playwright tests, PNGs you already have and native screenshots; one sentence on each and a link
   to its tutorial. This is the page a Chromatic user lands on when they ask "where do I start".
3. **Tutorial: a Storybook**: `init --storybook` against a running Storybook, the config it writes,
   shooting the stories, a story tagged `pixelslash-once`, one tagged `pixelslash-flaky-skip`, the
   error when a tag is misspelt (the exact text from `storybook.ts`), the report.
4. **Tutorial: your Playwright tests**: `npm install @hackcove/pixelslash-playwright`, a first spec
   with `snapshot(page, name, { ignore, redact })`, `npx playwright test` on plain Node,
   `pixelslash compare` of two snapshot dirs, and what `bare` means. Source it from
   `examples/playwright-node`, and fix the stale "not published" text in `cli.md:358` and that
   example's README in the same change.
5. **Tutorial: a site by URL**: `--routes FILE` for several pages, `--out`, `--ignore` for one
   moving area, and the result in one report; then the step up to `init` and `capture` for light and
   dark and two viewports (`variants` in the config).
6. **Tutorial: compare PNGs you already have**: the `import` route and `--live-png` / `--local-png`,
   including a native screenshot from Maestro with `--renderer`.
7. **Your first review on your own machine**: a change made on purpose, found, read in the report,
   and judged; the same with the design-system judge (`--ds`), including `skip: no judge`.
8. **Run it in CI**, a group of pages, each with a complete file:
   **GitHub Actions** (checkout with `fetch-depth: 0`, the pinned capture image, `capture`,
   `compare`, the report kept as a build artifact), **GitLab CI**, **CircleCI**, **Jenkins**,
   and **Any other CI** (plain shell). Write the first from a run on a scratch repository and the
   others only after the same shell steps ran in that provider or in its local runner; if a provider
   cannot be run, the page says "not tested on" and shows the shell steps instead. A **gate**
   section on each says which exit code fails the job and why a pixel-only run exits 0.
9. **Pin versions in CI**: the CLI version, the capture image digest and `PIXELSLASH_IMAGE_DIGEST`.
10. **Run a review server** (short, links to `/self-host`): when a team needs one, what it adds
    (`upload --wait`, exit 4 and 5), and `Block CI on review` as a CI variant. No hosted steps.

### PS-317: concepts, troubleshooting and FAQ

A new group "Concepts" and a group "Help" in `docs-map.ts`.

1. **How a comparison works, in plain words**: Main, Branch, the overlap when sizes differ, what a
   region is, a speck, noise, a sub-pixel shift, and how a run becomes `changed`. Links down to
   "How the diff works" for the numbers.
2. **Baselines and branches**: locally, the two sides you name; on a server, merge-base and ancestors,
   the first build on a branch, a shot a branch has not seen, what accepting does, and why a rejected
   build is never a baseline. Write it from `cli.md` "Uploading" and check each claim against the
   server code; do not restate the implementation notes.
3. **Thresholds**: `--threshold` (default 0.01), `minChangedPixels`, `minChangedRatio`, how the floors
   combine, and a worked example of moving one with before and after counts.
4. **Ignore or redact**: `--ignore`, `ignore`, `[data-pixelslash-ignore]`, `masks`; what each does to
   the stored shot; the case of an ignored element whose size changes.
5. **Flaky shots and stabilisation**: what settling waits for, the `stabilise` settings, retries,
   `flaky: "review"` and `"skip"`, and reproducing one with `pixelslash flake ID`.
6. **Fingerprints and environments**: what a fingerprint is, `bare`, why a shot from another machine
   is not comparable on a server and is diffed with a warning locally. Corrects the three
   unqualified sentences (`cli.md:308`, `380`, `407`).
7. **Reading a report**: a labelled walk through `report.html`, each state, the index for a routes
   run, the flaky view and the parity view.
8. **The review flow on a server you run**: upload, wait, accept, reject, what the CI exit codes
   mean. No hosted app.
9. **Exit codes**: the full table, 0 to 8, in plain words, with the `FAILED` line and the 7 rule.
10. **Troubleshooting**, built from the code, one entry per message with the exact string as a
    heading so search finds it, the cause and the fix: the storybook messages
    (`has no "entries": needs Storybook 7 or later`, `is not JSON`, `answered HTTP <n>`, `no story
    matches include/exclude`, `did not render within <n>ms`, `errored: <message>`, the tag
    errors), a page that never settles, `--only and --json do not go with --upload`, `missing value
    for --<flag>`, `unexpected argument`, `no token given`, `FAILED <command>: <stage>:`, `nothing
    was uploaded`, `upload incomplete`, `UPLOAD FAILED`, `rebaseline_needed`, `426 this project
    diffs in CI; upgrade the CLI`, and a down `baseUrl`. Pull the full list from the 177 throw
    sites with `grep -rn "new UsageError\|new CaptureError" packages/*/src` and cover the ones a user
    can reach; the real tickets (`ob`, `PS`) are the evidence, not the text.
11. **FAQ**, grouped like Chromatic's (comparison, usage, CI, environments) and answered in the
    first sentence: Does anything leave my machine? Do I need a server? Do I need Storybook? Why is
    every shot new? Why does CI pass when something changed? Can I use my own Playwright suite? Does
    it run on Windows or macOS? Can I stop an animation? What if my page has a clock?
12. **Coming from Chromatic**: a mapping table (story, build, baseline, PR check, UI Tests, UI
    Review, ignore, flake filter, threshold, TurboSnap) with what it becomes here, what has no
    equivalent and why, and a first-day plan. States the differences plainly, links the capability
    matrix for the rest, and does not disparage.

### PS-318: CLI reference, task-first and searchable

1. **A page template**: every `docs-map.ts` page opens with one sentence on what it is for and one
   working example, then the flags. The 17 cuts of `cli.md` need it; the contract stays one file, so
   the lead goes in as a short unlisted paragraph under each H2 that the cut keeps first. Needs a
   decision on where the lead lives (see Open questions).
2. **Split the three giants** in `docs-map.ts` using the H3 mechanism the test already supports:
   Uploading (7,622 words) into upload, baseline rules, flaky shots, `check`, block CI on review and
   monorepo tokens; Capture (4,274) into config, variants, `setup`, `masks` and `ignore`, `stabilise`,
   composition and accessibility; PNGs (2,893) into import, native, twins, parity, compare dirs.
3. **A CLI index page**: every command, one line, the page that owns it, with a flag table per
   command, generated at build time from `cli.md` so it cannot drift. Today the commands are found
   only by reading prose.
4. **An exit codes page** (the table from `cli.md:586`) linked from every page that can exit
   non-zero.
5. **Static client-side search**: an index built at prerender time from the same docs content
   (headings, text, and the exact error strings), loaded as one static file, queried in the browser,
   no request to any third party. A
   small build-time dependency is allowed and is named in the PR. Test: a query for an exact error
   string from the troubleshooting page returns that entry; a Playwright test checks the search box
   and that no request leaves the origin.
6. **Prev and next**: already in `docs.tsx` and covered by test ids. Keep, and test it across the new
   groups; no new component.
7. **Copy buttons on code blocks** (none found in `apps/site/src`), and an "Edit on GitHub" link
   per page now that the repo is public (`REPO_PUBLIC=true`).
8. **Move `SELF-HOST.md` into the docs nav**: it renders at `/self-host` but sits outside the nav and
   outside the search.
9. **Plain language pass on the reference**: define each term at first use or link to the concept
   page (baseline, fingerprint, carry, floor, speck, pick); no ticket ids in the rendered pages.

## Open questions for the planner

- **Where a page's lead lives (PS-318).** `docs.test.tsx` requires every H2 of `cli.md` to be on
  exactly one page, so a lead paragraph must either be the first lines under the H2 in `cli.md`
  itself or live in `docs-map.ts` as data. The first keeps one source; the second keeps `cli.md`
  a contract. This is for the builder of PS-318 to settle with the planner.
- **CI gates without a server (PS-316).** Chromatic's exit 1 means "changes found", so its CI pages
  gate on the exit code alone. A pixel-only run of ours exits 0 by invariant 3. A tutorial that
  fails a job on a visual change without a review server would need `--json` and a script, or a new
  flag. A new flag changes the CLI contract and is not a docs task, so the tutorial documents the
  script and nothing else.
- **Order.** PS-317 and PS-318 both link to the new concept pages, and PS-318 builds the search over
  all of them. The pages should land first (PS-316, PS-317), then search.

## Checks that were run

- `npm view @hackcove/pixelslash-playwright` (0.1.0, published 2026-11-04) and `npm view
  @hackcove/pixelslash dist-tags` (latest 0.7.0).
- The getting-started commands, run for real on two PNGs: 1,747 changed pixels, exit 0, output as
  documented.
- `grep` of `cli.md`, `getting-started.md`, `README.md` and `SELF-HOST.md` for "troubleshoot", "FAQ"
  and "Chromatic": none.
- `grep` of `apps/site/src` for a search: none. `PrevNext` is in `docs.tsx`.
- The throw sites: 177 `new UsageError(` or `new CaptureError(` calls in 51 files of
  `packages/*/src`.
- `.github/workflows`: `ci.yml`, `image.yml`, `release.yml`, `ui-review.yml`. None runs PixelSlash on a
  pull request against a server, so a GitHub Actions page cannot be copied from a workflow of ours
  and has to be written and run on a scratch repository.
