# Coming from Chromatic

The ideas are the same: shoot a page at a commit, compare it with an accepted image, put the difference in front of a person, and let CI read the decision. The names and the moving parts differ, and this page maps one to the other.

Nothing here needs a hosted account. The comparison runs on your machine; a server you run adds history and shared review.

## The map

| In Chromatic | Here |
| --- | --- |
| A story | A route. A Storybook story becomes a snapshot read from the running Storybook's `index.json`; a page by URL is a route too. One story is one snapshot, unless the config gives it globals combinations (variants) |
| A build | A build. `pixelslash upload` opens one at a commit and `pixelslash build` reads it; it holds every shot from that run |
| A baseline | A baseline: the accepted shot a new one is measured against. The server picks the branch's previous shot, else the nearest accepted shot at the merge-base or its ancestors |
| A PR check | A CI job that ends on `status --wait`. It captures, uploads, then exits by the review: 0 accepted, 4 rejected, 5 still waiting |
| UI Tests | `capture` and `compare`: the automated half of pixels, regions, thresholds and exit codes, run locally against baselines the server would pick (`check`) or against files you name |
| UI Review | [The review flow](../concepts/review-flow.md): a server you run shows the change, a person accepts or rejects, CI waits. There is no hosted service to sign up for today |
| Ignoring elements | `ignore`, `data-pixelslash-ignore`, `--ignore` and `masks`. Selectors follow the element; a mask paints the pixels out of the stored shot, so they never leave the machine |
| Flake filter | `--flake-retries` and the `flaky` policy. A changed shot is captured again; captures that disagree are `review` (wait for a person) or `skip` (kept out of the count) |
| Threshold | `--threshold` and the two floors: a per-pixel tolerance, plus a minimum count and a minimum share of the shot before a run is `changed` |
| TurboSnap | No equivalent. PixelSlash shoots the routes the config names, or the stories the Storybook index lists; it does not walk a bundler's dependency graph to decide what a change touched. `--only` narrows a local run by name |

The rest of the capability comparison, including the tools either side does not have, is in [the capability matrix](../capabilities/matrix.html).

## A first day

1. **Install and get a browser.** `npm i -D @hackcove/pixelslash`, then `npx pixelslash install-browser`. A PNG-only comparison needs no browser.
2. **Write a config.** `npx pixelslash init --storybook http://localhost:6006` reads the index and writes a `pixelslash.config.ts`; `init --url` does the same for a page. Edit names, viewports and themes there.
3. **Measure locally.** `npx pixelslash capture` shoots the routes, and `npx pixelslash compare DIR_A DIR_B` diffs two snapshot directories. For a pair of URLs, `--live` and `--local` are the two sides. Nothing is uploaded.
4. **Read the report.** Open `report.html` from `--out`. [Reading a report](../concepts/reading-a-report.md) labels it.
5. **Add a server when you want review.** Run one, log in, then `pixelslash capture --upload` and `pixelslash status --wait`. [Run a review server](../ci/review-server.md) is the whole path.
6. **Put it in CI.** Capture, upload, wait, and let the exit code fail the job. [GitHub Actions](../ci/github-actions.md) is a complete workflow; the other providers follow the same four steps.

## What is different, in practice

- **The comparison runs here.** Your machine (or your CI runner) does the diffing; the server stores shots and decisions. A local run needs no server at all, and a server never needs your source.
- **The CLI is the API.** Every command in the docs is the same thing your CI runs, and `/api/v1` is a documented contract. There is no separate UI-only operation to reproduce.
- **The unit is a shot, keyed by name, platform, browser, viewport and theme.** A changed viewport or a renamed route is a different shot, and a branch's first build has no baseline of its own; it compares at the merge-base. This is why a first upload can look busier than a later one.
- **A change is a measurement.** `capture` and `compare` exit 0 whether or not something changed. Only `status` turns a review into a pass or a fail, and exit 1 is reserved for design-system violations. [Exit codes](exit-codes.md) explains each number.
- **Tolerance is explicit.** A threshold, a minimum pixel count and a minimum ratio, plus noise and sub-pixel shift handling. [Thresholds](../concepts/thresholds.md) shows how the floors combine.
- **Nothing leaves unless asked.** No upload without `--upload`, no server without an address, and no error reporting without a DSN.

## Where the old habits do not carry over

- **A hosted review link is not part of the flow.** The review lives on a server you run, and the CLI reads its decision; do not wait for a link on `pixelslash.dev`.
- **There is no bundler integration.** The config is the list of what to shoot, and the Storybook index is read over HTTP. A story that is not in the index, or is excluded by your patterns, is not shot.
- **A flaky shot is reported, not smoothed over.** It is captured a fixed number of times, and the runs that disagree are reported as flaky; the policy decides whether that waits for a person or is skipped. There is no retry loop that hides the disagreement.

## Next

- [How a comparison works](../concepts/how-a-comparison-works.md): the words this page used.
- [Baselines and branches](../concepts/baselines-and-branches.md): what a server picks, in order.
- [FAQ](faq.md): the short answers.
