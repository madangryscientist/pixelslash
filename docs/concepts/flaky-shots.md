# Flaky shots

A flaky shot differs from itself: the same code, shot twice, gives two images. PixelSlash prevents most of that before the shot, detects the rest after it, and helps you fix the cause.

## What a shot waits for

Before each shot, capture waits for the page to settle, in this order:

1. Web fonts are ready.
2. Every image has loaded.
3. The network has gone idle.
4. Two animation frames have been drawn.

This can't be turned off. It is bounded by `timeoutMs`, 8 seconds by default. A page that doesn't settle in time fails with `capture settle exceeded <n>ms`. It doesn't hang, and it doesn't shoot early.

Capture takes up to four shots at once, each with its own timeout and all sharing the CPU. A page that only just settles when shot alone can run out of time here.

## Stabilisation

The `stabilise` settings stop a page moving while it is shot. These are the defaults:

```json
{
  "stabilise": {
    "animations": true,
    "caret": true,
    "clock": "2026-01-01T00:00:00.000Z",
    "timers": true,
    "deviceScaleFactor": 1,
    "timeoutMs": 8000
  }
}
```

| Setting | Default | What it does |
| --- | --- | --- |
| `animations` | `true` | Turns off animations and transitions. A finite one jumps to its end, an infinite one resets |
| `caret` | `true` | Hides the text caret |
| `clock` | fixed date | Freezes `Date.now()` and `new Date()` at this date. `false` keeps the real clock |
| `timers` | `true` | Pauses page timers. `false` lets them run |
| `deviceScaleFactor` | `1` | Pixels per CSS pixel |
| `timeoutMs` | `8000` | The bound on the settle |

A page with an infinite CSS animation, an interval counter and a `requestAnimationFrame` loop, shot twice with these defaults:

```
pixelslash: 0 changed, 1 unchanged, 0 new, 0 removed
```

The same page with `"stabilise": { "animations": false, "clock": false, "timers": false }`:

```
pixelslash: 1 changed, 0 unchanged, 0 new, 0 removed
changed:
  anim (chromium 1280x720)
```

Zero-delay timers still run at load. A page that needs a delayed timer in order to render needs `timers: false`.

`timers: true` needs a clock to pause, so with `clock: false` you must also set `timers: false`, or the run stops with `config: stabilise.timers needs a clock to pause: set stabilise.clock, or timers: false`.

## How a flake is detected

Detection happens on upload. When a shot differs from its baseline, `--upload` captures it again, by default 2 more times. `flake: { "retries": N }` in the config or `--flake-retries N` changes that, and 0 turns it off.

If the captures disagree with each other, the shot is flaky. That says nothing about whether the change is wanted.

A shot needs a baseline before it can be detected. The first upload of a new shot measures it against nothing, so it isn't captured again and `flakes` lists nothing yet. The second upload is where it shows:

```
npx pixelslash capture --upload --out snapshots/f1
```

```
pixelslash: 3 snapshots
pixelslash: uploaded 3 snapshots
build: b58931e1-… (2937d20 on flaky-branch)
flaky: rand (1280x720 light): 1 of 3 runs differed; policy review
report: file:///…/my-site/snapshots/f1/report.html
```

Detection is a sample. A shot that happens to agree three times is reported as a plain change.

That `report.html` shows each run side by side and lists where they differed. The extra captures are kept in `@flake/` beside the shots. Its first lines count what happened:

```
1 flaky · 0 changed in every run · 0 not captured again · each changed shot captured 2 more times
```

## `flaky: "review"` or `flaky: "skip"`

The `flaky` setting says what a flaky shot does to the build. Set it at the top level or on a route. A route's value wins.

| What happens | `"review"` (default) | `"skip"` |
| --- | --- | --- |
| In the build | badged flaky, and it waits for a decision | marked `skipped: flaky`, and not in the count to review |
| Blocks the build | yes | no |
| Accepted | only by a person | never automatically, but a reviewer may still accept or reject it by hand |
| Becomes a baseline | when accepted | no, unless a reviewer accepts it, so the next build is measured against the old one |

`"review"` is the default because a flaky shot can also hide a real change. `"skip"` keeps a shot you can't fix yet out of the way. `status --wait` lists a skipped shot on its own `skipped flaky:` line.

Storybook stories use the tags `pixelslash-flaky-review` and `pixelslash-flaky-skip`.

## Find the cause: `pixelslash flake ID`

`pixelslash flakes` lists the open flakes on the server:

```
npx pixelslash flakes
```

```
a5453507-…  rand (chromium 1280x720 light)  1 build  2026-11-05T13:55:30.832Z
reproduce one locally: pixelslash flake ID
```

`pixelslash flake ID` then captures that one shot several times on your machine and compares each run with the first. Your `baseUrl` must already be up. Nothing is uploaded.

```
npx pixelslash flake a5453507-… --runs 4 --out fl1
```

```
flake a5453507-…: rand (chromium 1280x720 light), open; capturing it 4 times here
run 2: same
run 3: differed (real change)
  real change: 200x60 at 20,20 (12000 px)
run 4: differed (real change)
  real change: 200x60 at 20,20 (12000 px)
unstable: 2 of 3 runs differed from run 1
what to change:
  1. The runs differ in one area, 200x60 at 20,20 (CSS px). If that is live content (a random or rotating element, an ad, a map), ignore it there, for the chromium-1280x720-light variant of rand. Better still, if you own the element, make it render the same (a seed for its randomness, fixed test data) or give it `data-pixelslash-ignore`. [--write]
  2. Last resort: set `flaky: "skip"` on rand, so the server keeps its flaky changes out of review. It is still captured. [--write]
report: file:///…/fl1/report.html
```

It exits 6 when the shot is unstable and 0 when it is stable. `--runs` defaults to 5.

`--suggest` prints the exact edits without writing them:

```
  1: routes[2].variants.chromium-1280x720-light.ignore += {"x":20,"y":20,"width":200,"height":60}
  2: routes[2].flaky = "skip"
nothing written; --write writes the one you pick
```

`--write` asks at the terminal and writes the number you type. Once the shot is stable here, `--resolve` closes the flake on the server. While it's unstable, it refuses:

```
not resolved: the shot is still unstable here
```

## Next

- [Ignore or redact](ignore-or-redact.md): for an area that will always change.
- [Fixing a flake locally](../cli.md#fixing-a-flake-locally): every flag of `flake`.
- [The review flow](review-flow.md): what a waiting shot blocks.
