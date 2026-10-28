# Playwright on plain Node, with PixelSlash snapshots

A project outside the workspace that takes PixelSlash snapshots from its own Playwright tests, the way
a team that has never heard of Bun would: `npx playwright test` on Node, then `pixelslash upload`.

It installs the two **packed** packages, not the workspace:

- `@hackcove/pixelslash-playwright`, the helper (`snapshot(page, name, opts)`), which runs under Node;
- `@hackcove/pixelslash`, the CLI, which uploads the dir and needs Bun (`bun` on the machine that
  uploads, not on the one that runs the tests).

Neither is on npm yet (publishing waits on the open-source decision), so build and install the tarballs:

```bash
bun scripts/pack-npm.ts packs        # from the repo root: prints the two tarball paths
cd examples/playwright-node
npm install ../../packs/hackcove-pixelslash-playwright-*.tgz ../../packs/hackcove-pixelslash-0.*.tgz
npx playwright install chromium-headless-shell
npx playwright test                  # writes pixelslash-snapshots/ (manifest.json + PNGs)
pixelslash upload pixelslash-snapshots --server https://your-server
```

`bun scripts/check-example.ts` does all of this in a temp copy, the way CI does: it runs the tests with no
`bun` on `PATH`, type-checks the spec against the shipped declarations, and uploads the dir to a stub
server.
