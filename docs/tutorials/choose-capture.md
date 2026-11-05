# Choose how to capture

PixelSlash compares screenshots. How they get made is up to you, and there are five routes. Each one ends in the same report.

## The five routes

- **URLs and `--routes`.** Your app is up somewhere and you give PixelSlash its pages, by URL or from a list: [a site by URL](urls.md).
- **Storybook.** You have stories, and PixelSlash reads the running Storybook's index and shoots each one: [a Storybook](storybook.md).
- **Your Playwright tests.** Your tests already reach the right states, so they take the shots with `snapshot(page, name)`, on plain Node: [your Playwright tests](playwright.md).
- **PNGs.** Something else makes your screenshots, and PixelSlash diffs what you hand it, with no browser: [PNGs you already have](pngs.md).
- **Native (Maestro).** A device or emulator makes the screenshots of a mobile app, and you import them with the platform, device and scale: [native screenshots](pngs.md#native-screenshots).

## Where to start

New to it? Start with [Getting started](../getting-started.md), then [your first review](first-review.md). Once one route works on your machine, [Run it in CI](../ci/github-actions.md) has a complete setup per provider.
