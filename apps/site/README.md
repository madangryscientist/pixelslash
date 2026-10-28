# apps/site: pixelslash.dev

The project site. TanStack Start on a Cloudflare Worker, every page prerendered to static HTML at
build time: no D1, no R2, no sign-in, no analytics, no cookies, no forms, no third-party fonts or
scripts. It collects nothing.

The pages are drawn from the repo's own files, read when the site is built, so the site says what
the code says at that commit:

| Page | Source |
| --- | --- |
| `/docs` | `docs/cli.md` |
| `/self-host` | `apps/web/SELF-HOST.md` |
| `/security` | `SECURITY.md` |
| `/compare` | `docs/capabilities/data.json` (the behind rows included) |
| `/how-it-works` | `public/report.png`, a real report of `fixtures/pages/live.html` against `local.html` |
| footer | the README's trademark line |

The pricing page's commitment sentence is `src/content/pricing.ts`.

## Before the repository and the app open

The site goes public before the repository (PS-257) and before the hosted app, so no link may lead
where a visitor cannot follow. Two switches in `src/content/links.ts`, both `false`:

- `REPO_PUBLIC`: links to the GitHub repository, its files and its images. Off, they are drawn as
  text and the site says the source opens at launch.
- `APP_LIVE`: links to `app.pixelslash.dev`. Off, there is no Sign in link.

Flip one, rebuild and deploy. The smoke test checks that nothing links to either while they are off,
so it needs the same change.

## Run it

```bash
bun run dev              # vite dev on :3100
bunx nx build site       # prerenders every page into dist/client
bunx nx test site        # the docs and compare pages against their source files
bunx nx test:e2e site    # Playwright on the build, desktop and phone: nav, footer, dead links
```

`SITE_SHOTS_DIR=<dir> bunx nx test:e2e site` also writes a full-page screenshot of every page.

## Deploy

One command, from `apps/site`, with a Cloudflare API token for the account that holds the
`pixelslash.dev` zone in `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`):

```bash
bun run build && bunx wrangler deploy
```

`wrangler.jsonc` attaches the Worker to `pixelslash.dev` as a custom domain (`workers_dev` is off),
so the deploy creates the hostname's DNS record itself. `bunx wrangler deploy --dry-run --outdir
<dir>` builds the upload without sending it.
