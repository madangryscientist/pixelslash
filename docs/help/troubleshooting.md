# Troubleshooting

Every entry here is a message or a status you can meet, word for word, so you can search the page for the line you saw. The heading is the message; the text under it says what caused it and what to do.

Start with [the `FAILED` line](exit-codes.md#the-failed-line): if the run ended with `pixelslash: FAILED`, the stage in that line tells you which part of the page to read.

## storybook: `<url>` has no "entries": needs Storybook 7 or later

PixelSlash reads `<url>/index.json` and expected Storybook's 7 or later format, which lists every story under `entries`. A Storybook 6 index has `stories` instead, so there is nothing to shoot.

Upgrade Storybook, or point `storybook.url` at a 7 or later server. If you cannot upgrade, list the stories as [routes](../cli.md#snapshot-capture-the-pinned-image) instead.

## storybook: `<url>` is not JSON

The address answered, but the body was not JSON. The usual cause is a URL that lands on the Storybook's HTML page, or a proxy's sign-in page, instead of `index.json`.

Check that `storybook.url` is the Storybook's origin, without a path, and open `<url>/index.json` in a browser: it should be the index itself.

## storybook: `<url>` answered HTTP `<n>`

The request for the index failed with that status. `404` means the URL is not a Storybook origin; `401` or `403` means something in front of it wants credentials; `500` means Storybook itself is unhappy.

Fix the address or the proxy, and make sure the Storybook is built and running in the same job.

## storybook: no story in `<url>` matches include/exclude

The index was read, but the config's `storybook.include` and `storybook.exclude` left nothing. A run that shoots nothing would pass for ever, so this is a usage error rather than an empty build.

Widen the patterns, or remove them. `include` takes glob patterns matched against a story's title and id; a story outside every `include` is dropped, and one inside any `exclude` is dropped too.

## story `<name>` did not render within `<n>ms`

The story's page never signalled that it had rendered, before the route's `timeoutMs` ran out. The story may await data, throw during render, or render only after an interaction.

Open the story's iframe URL directly. If it needs data, provide it in the preview (a mock or a setup script); if it needs a click, it is not a snapshot yet.

## story `<name>` errored: `<message>`

Storybook reported the story as failed, and the message is Storybook's own. The render threw, or a decorator did.

Read the message: it is the error Storybook would show in its canvas. Fix the story, then run again.

## storybook: story "`<id>`" tag "`<tag>`" must be pixelslash-flaky-review or pixelslash-flaky-skip

A story carries a tag beginning `pixelslash-flaky-` that is not one of the two policies. PixelSlash will not guess what a misspelt tag meant.

Use `pixelslash-flaky-review` or `pixelslash-flaky-skip`, or remove the tag. [Flaky shots](../concepts/flaky-shots.md) explains the difference.

## storybook: story "`<id>`" has both pixelslash-flaky-review or pixelslash-flaky-skip

The story carries both policy tags, so the policy is ambiguous. PixelSlash prints the two tag names joined by "or" in this message.

Keep one tag. `review` makes the shot wait for a person; `skip` keeps it out of review.

## capture settle exceeded `<n>ms`

The page did not settle within `timeoutMs` (8 seconds by default). Capture waits for web fonts, every image, the network (no request in flight) and two animation frames; one of those never finished.

Open the page with the network panel: a request that never ends, an image that never loads, or a page that keeps scheduling work will all do it. Raise `timeoutMs` only after you know which one it is. [Flaky shots](../concepts/flaky-shots.md#what-a-shot-waits-for) lists what the settle waits for.

## capture failed for `<url>`: `<reason>`

The browser could not load the page. The commonest reason is that nothing is listening: a down `baseUrl`, a dev server that did not start, or a typo in the port.

Start the app first. `capture`, `check` and `dev` never start a dev server for you; only the pinned image's config may start one. A `HTTP <n>` reason is the page answering with an error status, which is the app's problem, not the network's.

## --only and --json do not go with --upload

`--only` and `--json` narrow or reshape a local capture, and neither can be honoured by an upload, which sends everything it captured and prints a build link.

Drop one of the three. If you want a JSON reply, read the build afterwards with `pixelslash build <id> --json`.

## missing value for --`<flag>`

A flag that needs a value was the last thing on the line, or the thing after it was another flag:

```
pixelslash --live-png main.png --local-png --out report
```

Here `--local-png` has no value, because the next word is `--out`: a value beginning with `--` is read as a flag, not as a path. Give every flag its value, and quote a path with spaces.

## unexpected argument: `<argument>`

The command does not take that positional argument, or the flag was written with one dash. Check the usage line in [the CLI reference](../cli.md), or run the command with no arguments to see it.

## no token given

`pixelslash login` read an empty token: stdin ended, or the terminal input was blank. It has printed the settings address above this line.

Create a personal token (`psu_…`) at that address and paste it. In CI, do not use `login`: put the CI token in `PIXELSLASH_TOKEN` or a file named by `--token-path`.

## pixelslash: FAILED `<command>`: `<stage>`: `<message>`

An error PixelSlash did not expect: a crash, or a shot the diff could not decode. This is exit 7, which is a bug in PixelSlash, never a verdict on your page.

Keep the line and the stack below it, and escalate. Do not retry it as if it were a flaky shot. [Exit codes](exit-codes.md#7-a-bug-in-pixelslash) has the full line and what a runner must do.

## nothing was uploaded

This is the second line of a `FAILED` run, or of an `UPLOAD FAILED` run, and it means what it says: the build had not opened, so no shot reached the server. A retry will not duplicate anything.

If the first line says `upload:`, the failure was in opening the build. Read that message for the server's answer.

## upload incomplete: `<n>`/`<m>` shots sent

The upload stopped after some shots reached the server. The build exists but was never finalised, so it is not counted and nobody is asked to review it.

Nothing is lost on disk. Run the upload again; it opens a new build. The number tells you how far the last attempt got.

## UPLOAD FAILED: `<reason>`

The upload reached a server that refused it, or the build it opened ended `errored`. The line before it says what reached the server; the line itself is the reason.

- A refused token or project is a 401 or 404: check the token and `upload.project`.
- `build … errored on the server` names the reason and, when there is one, the build's page. The commonest is [a fingerprint from another environment](../concepts/fingerprints.md#on-a-server-not-compared).
- A build that errored is not retried: fix the cause and upload again.

## rebaseline_needed

A server-side status, not a command's own message: a shot's fingerprint differs from its baseline's, so the server refused to compare them. On the default branch the shot is accepted and becomes the new baseline; on any other branch the build ends `errored` and `upload` exits 1.

Move the baseline first: upload the default branch from the new environment, rebase your branch onto that commit, then upload the branch again. [Fingerprints and environments](../concepts/fingerprints.md#on-a-server-not-compared) walks through it.

## this project diffs in CI; upgrade the CLI

The project is set to diff in CI, and this CLI is older than the version that can do it. The server answers HTTP 426 rather than measuring a build the project asked it not to measure.

Upgrade `@hackcove/pixelslash` and run the job again. If you pin the version in CI, raise the pin in the same change.

## --threshold must be a number from 0 to 1

Every diff setting that is a ratio takes a number from 0 to 1: `--threshold`, `--min-changed-ratio`, `--noise-amplitude` and `--max-shift`. A percentage such as `5` is not 5%; it is out of range.

Use `0.05` for five percent. The same rule applies to the config's `diff` keys. [Thresholds](../concepts/thresholds.md) has the defaults and how the floors combine.

## config: stabilise.timers needs a clock to pause: set stabilise.clock, or timers: false

`stabilise.timers: true` pauses page timers, and pausing needs a fixed clock. With `stabilise.clock: false` there is no clock to pause at, so the config is contradictory.

Either keep the clock (the default is a fixed date), or set `timers: false` as well. [Flaky shots](../concepts/flaky-shots.md#stabilisation) has both settings.

## no manifest.json in `<dir>`

`upload` or `compare` was pointed at a directory that is not a snapshot directory. Capture, `check` and `import` write `manifest.json` beside the PNGs; a directory of loose PNGs needs `pixelslash import` first.

Check the path. A relative path is resolved from where you ran the command, not from the config file.

## --out `<dir>` overlaps the snapshot dir `<dir>`

`compare` refuses an output directory that is, holds or sits inside either input. Writing the report into the snapshots would make the next run read its own output.

Give `--out` a directory outside both inputs, such as `.pixelslash/compare`.

## no .png files in `<dir>`

`import` found no PNG at any depth. It ignores every other file, so an empty directory and a directory of JPEGs give the same message.

Check the path, and that the files end in `.png` in lower case.

## warning: mask "`<selector>`" matched no shot in this run

A `masks` selector matched nothing, so nothing was redacted. A renamed class or a changed DOM silently stops protecting the shot, which is why this is a warning and not silence.

Fix the selector. If the element is gone on purpose, remove the entry; [Ignore or redact](../concepts/ignore-or-redact.md#masks-redact) has the difference between a mask and an ignore.

## Next

- [Exit codes in plain words](exit-codes.md): what the number at the end means.
- [FAQ](faq.md): the questions that are not a failure.
- [Coming from Chromatic](coming-from-chromatic.md): the same ideas under other names.
