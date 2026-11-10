# Tutorial: your Playwright tests

Your tests already log in, click through and reach the states you care about. Take the shots there, with one call, on plain Node.

The helper is `@hackcove/pixelslash-playwright` on npm. It runs in your tests with no Bun. Comparing the results later uses the CLI, which does need [Bun](https://bun.sh) on your `PATH`.

Before you start: if Getting started left its two servers running on ports 4101 and 4102, stop them first (`kill %1 %2` in the shell that started them, or close it): this page serves its own pair on the same ports.

## Install

In a project with Playwright, or in a new one:

```
mkdir my-tests && cd my-tests
npm init -y
npm pkg set type=module
npm install -D @playwright/test @hackcove/pixelslash-playwright @hackcove/pixelslash
npx playwright install chromium-headless-shell
```

## A page to shoot

If you have an app, run it twice, on main and on your branch, on ports 4101 and 4102, and skip to the next section. Otherwise, make a small account page. It has a clock that changes all the time, a session token and a plan:

```
mkdir main
cat > main/index.html <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Account</title>
    <style>
      body { font: 16px/1.5 sans-serif; margin: 40px; color: #1f2933; }
      #clock { height: 24px; width: 260px; }
      .token { background: #f1f5f9; padding: 4px 8px; border-radius: 4px; font-family: monospace; }
      .plan { font-size: 20px; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Account</h1>
    <p id="clock"></p>
    <p class="token">session abc123</p>
    <p class="plan">Plan: free</p>
    <script>
      const tick = () => (document.getElementById("clock").textContent = new Date().toISOString());
      tick();
      setInterval(tick, 50);
    </script>
  </body>
</html>
HTML
```

Copy it to Branch and change the plan there. This is GNU `sed`; on a Mac, use `sed -i ''`, or edit the file by hand:

```
cp -r main branch
sed -i 's/Plan: free/Plan: team/' branch/index.html
```

Serve each copy on its own port, and leave them running:

```
npx --yes serve -l 4101 main &
npx --yes serve -l 4102 branch &
```

## A first spec

This spec opens the account page above, with Main on port 4101 and Branch on port 4102. Point it at your own app if you have one.

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:4101",
    browserName: "chromium",
    // snapshot() needs a launched chromium and a fixed viewport.
    viewport: { width: 1024, height: 768 },
  },
});
```

`tests/account.spec.ts`:

```ts
import { test } from "@playwright/test";
import { snapshot } from "@hackcove/pixelslash-playwright";

test("the account page", async ({ page }) => {
  await page.goto("/");
  // The clock moves on every shot, so the diff skips it. The token is painted over before the PNG is written.
  await snapshot(page, "account", { ignore: ["#clock"], redact: [".token"] });
});
```

`snapshot(page, name, options)` takes the shot. Both options take selectors:

- `ignore` leaves an area out of the diff. The pixels stay in the PNG.
- `redact` paints an area over before the PNG is written, so what was there never reaches the file. Use it for tokens and personal data.

## Run it on each side

`PIXELSLASH_SNAPSHOT_DIR` says where the shots go, and `BASE_URL` is read by the config above:

```
PIXELSLASH_SNAPSHOT_DIR=snapshots/main BASE_URL=http://localhost:4101 npx playwright test
PIXELSLASH_SNAPSHOT_DIR=snapshots/branch BASE_URL=http://localhost:4102 npx playwright test
```

```
Running 1 test using 1 worker

  ✓  1 tests/account.spec.ts:4:1 › the account page (1.1s)

  1 passed (1.4s)
```

Each directory now has `account/1024x768-light.png` and a `manifest.json`, where the `#clock` selector has become the rectangle it covered:

```json
"ignore": [{ "x": 40, "y": 109, "width": 260, "height": 25 }]
```

## Compare the two directories

```
npx pixelslash compare snapshots/main snapshots/branch --out report
```

```
timing: 1 shot, diff 0.0s, total 0.0s
pixelslash: 1 changed, 0 unchanged, 0 new, 0 removed
changed:
  account (chromium 1024x768)
report: file:///…/my-tests/report/index.html
```

The exit code is 0. Open `report/index.html`:

![The compare index: the account page, 158 changed pixels](../../apps/site/public/docs-images/pw-index.png)

The report has the plan's change from free to team, and says what it did not measure: "6500 ignored pixels", the clock's area. The token's area was painted over in both PNGs, so it matches and is not in the crop: open `snapshots/main/account/1024x768-light.png` to see the band that took its place.

![The account page's report: the plan change, with the clock ignored](../../apps/site/public/docs-images/pw-report.png)

## What a bare fingerprint means

Each manifest records what rendered its shots:

```json
{ "image": "bare", "browser": "chromium 158.0.8127.18", "fonts": "sha256:23446422e9ce6060cc0416419d2f4f5cbfecde26ba104d588ed88a1fe4cbdb0a" }
```

`bare` means the shots did not come from the pinned capture image: they came from your own browser, with your machine's fonts. It is not an error. Two machines can draw the same page differently, though, so keep both sides of a comparison on one machine, or one CI runner image. When the fingerprints of two sides differ, `compare` warns and diffs anyway, and then a font can look like a change.

## Next

- A complete project, with a test that runs on plain Node: [`examples/playwright-node`](../../examples/playwright-node/README.md).
- Everything `snapshot` takes: [Snapshots from your own Playwright tests](../cli.md#snapshots-from-your-own-playwright-tests).
- Run it on every pull request: [Run it in CI](../ci/github-actions.md).
