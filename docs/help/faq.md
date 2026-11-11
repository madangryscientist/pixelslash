# FAQ

Short answers to the questions that come up before and after a first run. Each one starts with the answer, and links to the page that has the detail.

## Does anything leave my machine?

No, unless you ask it to. `capture` and `compare` write files under `--out` and send nothing; `--upload` sends the shots to the one server you name, and nowhere else.

Each of these is opt-in and off by default. Everything else stays on the machine.

- **Upload.** `pixelslash upload` and `capture --upload` send the shots to the server you name, and to no other. In a project whose diff runs in CI they also send the diff results and the mask. `check` and `--against main` also talk to that server, but send git context and entries, no PNG.
- **A hosted judge model.** With `PIXELSLASH_OPENCODE_MODEL` set, every judge call sends the images it is judging to that model's provider, instead of to the local mlx or ollama model. The DS judge sends the shot and the design-system raster; `dev --judge` sends the shot, the reference image and the spec text; `upload --judge` sends the main and branch shots for the one-sentence change note. Unset, nothing leaves the machine.
- **The server's AI explanations.** After an upload, if a project (or its org) on that server names an AI model, the server sends that endpoint three crops of each `change` region (baseline, branch and diff, cut to the region's box plus 16 px on each side) and, for the build summary, text only (shot names, counts, those region notes and the brief, if you gave one with `upload --brief`). It never sends a whole shot.
- **The error report.** With `PIXELSLASH_SENTRY_DSN` set, a crash and an `UPLOAD FAILED` run are reported to that Sentry project: a message, a stack, the release, the environment and the tags `kind`, `command` and `stage`. No shot is sent, and tokens, cookies and query strings are removed first.
- **Figma.** A Figma fetch sends your Figma token and the file or node ids to Figma's API, and nothing from your pages.
- **Your coding agent.** The MCP server (`pixelslash mcp`) returns shots, for example from `capture_local`, to the agent that called it, so where they go next is that agent's model.

[The privacy rule](../cli.md#uploading-to-a-server) is the full statement.

## Do I need a server?

No. A server adds history, shared review and a CI gate that survives a rerun; it is not needed to compare two versions or to read a report.

Without one, you name both sides of every comparison yourself, and nothing is remembered between runs. [Baselines and branches](../concepts/baselines-and-branches.md#on-your-own-machine-the-two-sides-you-name) has that mode; [Run a review server](../ci/review-server.md) has the other.

## Do I need Storybook?

No. A Storybook is one way to capture: PixelSlash reads a running Storybook 7 or later index and shoots every story (or the ones your patterns keep). You can also shoot pages by URL, a directory of PNGs, or your own Playwright tests.

[Choose how to capture](../tutorials/choose-capture.md) compares the routes, and [A Storybook](../tutorials/storybook.md) is the step-by-step.

## Why is every shot new?

Because a shot's identity is more than its name: name, platform, browser, viewport and theme all have to match a baseline before anything is compared. A new viewport, a renamed route, a new browser or the branch's first build all produce shots the server has no baseline for.

On a server, a shot is `new` when the branch has no earlier shot of it and there is no accepted shot at the merge-base or its ancestors. A shot from another machine is not `new`: it is refused as [a fingerprint from another environment](../concepts/fingerprints.md#on-a-server-not-compared).

## Why does CI pass when something changed?

Because a change is a measurement, not a failure. `capture` and `compare` exit 0 whether or not they found a difference, and `upload` exits 0 when the upload worked, not when the change is approved.

To make CI wait for a person, end the job on `pixelslash status --wait` (or `upload --wait`): it exits 4 on a rejection and 5 while the build is still waiting. To fail on the design system instead, pass `--ds` (or `--file`) to the pair run: new violations on Branch exit 1. [Exit codes](../help/exit-codes.md) is the whole contract.

## Can I use my own Playwright tests?

Yes. `@hackcove/pixelslash-playwright` gives your test a `snapshot(page, name, { ignore, redact })` call that settles the page, writes the PNG and records the ignore boxes. The directory it writes is a snapshot directory, so `pixelslash upload` takes it unchanged.

It runs under plain `npx playwright test` on Node. [Snapshots from your own Playwright tests](../cli.md#snapshots-from-your-own-playwright-tests) has the import and the flags.

## Which operating systems does it run on?

Linux is what runs on every change: our CI and the pinned capture image are Linux, and that is the combination exercised. The CLI is a Bun program and uses Playwright, which also build for macOS and Windows, but this repo does not test either.

Outside the pinned image, a run records a [`bare` fingerprint](../concepts/fingerprints.md#bare) and warns: the machine's own fonts and browser build shift the pixels. For team-wide baselines, capture both sides in the image.

## How do I stop an animation?

Leave `stabilise.animations` on, which is the default. It turns off CSS animations and transitions: a finite animation jumps to its end, an infinite one resets, and the shot is the same every time.

If the element still moves, it is not an animation: ignore its area, or fix what makes it change. [Flaky shots](../concepts/flaky-shots.md#stabilisation) lists the other stabilise settings.

## What about a page with a clock?

`stabilise.clock` fixes `Date.now()` and `new Date()` at one instant, `2026-01-01T00:00:00.000Z` by default, so a rendered timestamp is the same on every run. `stabilise.timers` pauses `setTimeout` and `setInterval`, and needs a clock to pause.

If you want the real clock, set `clock: false` and `timers: false` together. A page that then differs by itself needs its clock moved out of the shot, or its area ignored.

## Can I compare two PNGs without a browser?

Yes. `--live-png` and `--local-png` take two files, and `compare` takes two snapshot directories; neither launches a browser or needs `install-browser`.

That is also the path for shots from another tool. [PNGs you already have](../tutorials/pngs.md) has the flags, and `import` is what turns a directory of them into a snapshot directory.

## How do I shoot only one page?

Use `--only NAME` on `capture` or `check`, repeated for more than one. A name is a route's name or a story's id, and an unknown name is a usage error rather than a silent empty run.

`--only` is local only: it does not go with `--upload`. [Troubleshooting](../help/troubleshooting.md#--only-and---json-do-not-go-with---upload) has that message.

## Where is the report?

Next to what you asked for: `report.html` for one pair, `index.html` plus a `report.html` per page for several, both under `--out`. They open as plain files with no server.

[Reading a report](../concepts/reading-a-report.md) labels each part of the page, and [The report](../cli.md#the-report) lists every section.

## Next

- [Coming from Chromatic](coming-from-chromatic.md): the same ideas under the names you know.
- [Troubleshooting](troubleshooting.md): when a message is the answer.
- [Exit codes](exit-codes.md): what CI reads.
