# Pin versions in CI

A diff is only worth reading when the change came from your code. Pin what renders the shots, or a new browser or font in a later image will look like a change on every page.

**Tested on** GitHub Actions, on an `ubuntu-24.04` runner, on 2026-11-04, for the image commands. The CLI pin ran on a desktop machine.

## The CLI version

If the job runs the CLI from npm, pin the exact version:

```
npm i -D -E @hackcove/pixelslash@0.7.0
```

`-E` writes `"@hackcove/pixelslash": "0.7.0"` to `package.json`, with no `^`. Check what you got with `npm ls`:

```
$ npm ls @hackcove/pixelslash
my-site@1.0.0 …
└── @hackcove/pixelslash@0.7.0
```

Read the version from there. `npx pixelslash --version` prints the engine's version, `pixelslash 0.1.0`, not the package's.

## The capture image digest

A tag can be moved. A digest cannot. Get the digest once, from the tag:

```
docker pull ghcr.io/madangryscientist/pixelslash-capture:0.7.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/madangryscientist/pixelslash-capture:0.7.0
```

```
ghcr.io/madangryscientist/pixelslash-capture@sha256:d8b33a8e9fac68f41d04e5295cdf7b57ab22affca73f081f2b18241d2e633fff
```

Then name the image by that digest in your CI file. It only changes when you change it, in a commit. The image is for `linux/amd64`.

## `PIXELSLASH_IMAGE_DIGEST`

Each manifest has a fingerprint of what rendered it. The image does not know its own digest, so you pass it in. Without it:

```
IMAGE=ghcr.io/madangryscientist/pixelslash-capture@sha256:d8b33a8e9fac68f41d04e5295cdf7b57ab22affca73f081f2b18241d2e633fff
docker run --rm --network host -v "$PWD:/work" "$IMAGE" capture --out snapshots/no-digest
```

```
fingerprint: {"image":"version:0.7.0","browser":"chromium 156.0.8078.4","fonts":"sha256:b94a854b9906469b346d4f39cae49b20342e1abc9501e597fed6b1c44d5a0bbb"}
```

With it:

```
docker run --rm --network host -v "$PWD:/work" -e PIXELSLASH_IMAGE_DIGEST="$IMAGE" "$IMAGE" capture --out snapshots/digest
```

```
fingerprint: {"image":"ghcr.io/madangryscientist/pixelslash-capture@sha256:d8b33a8e9fac68f41d04e5295cdf7b57ab22affca73f081f2b18241d2e633fff","browser":"chromium 156.0.8078.4","fonts":"sha256:b94a854b9906469b346d4f39cae49b20342e1abc9501e597fed6b1c44d5a0bbb"}
```

Pass it on both sides. Two runs with different values do not match, even from the same image:

```
docker run --rm -v "$PWD:/work" "$IMAGE" compare snapshots/no-digest snapshots/digest --out report-mixed
```

```
warning: index (chromium 1280x720): rendered by a different image; diffing anyway
timing: 1 shot, diff 0.0s, total 0.0s
pixelslash: 0 changed, 1 unchanged, 0 new, 0 removed
fingerprint: 1 differ (diffed anyway)
report: file:///work/report-mixed/index.html
```

The warning goes away when both sides carry the same fingerprint, which is what the [GitHub Actions](github-actions.md) job does. Shots taken outside the image say `bare` instead: see [what a bare fingerprint means](../tutorials/playwright.md#what-a-bare-fingerprint-means).

## Moving to a new image

A new image can render differently. Change the digest in its own commit, on a branch with no other change, and read what the job reports. What it shows is the image's doing, not your code's.
