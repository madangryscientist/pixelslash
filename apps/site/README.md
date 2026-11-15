# apps/site: pixelslash.dev

The project's docs site. TanStack Start on a Cloudflare Worker, every page prerendered to static
HTML at build time: no D1, no R2, no sign-in, no cookies, no forms. pixelslash.dev serves the docs,
self-host and security pages.

## The marketing pages moved

The home, how it works, compare and pricing pages are on slashslash.build now. pixelslash.dev answers
each old path, with and without a trailing slash, with a `301` to its new address:

| Path | Location |
| --- | --- |
| `/` | `https://slashslash.build/pixelslash` |
| `/how-it-works` | `https://slashslash.build/pixelslash/how-it-works` |
| `/compare` | `https://slashslash.build/pixelslash/compare` |
| `/pricing` | `https://slashslash.build/pixelslash/pricing` |

The list is `src/content/moved.ts`. The Worker's own entry, `src/server.ts`, answers it before
TanStack Start does; no asset matches those paths, so every such request reaches the Worker. The nav
(`src/content/nav.ts`) still shows the four, linking to slashslash.build, and the wordmark links the
PixelSlash home there. `e2e/metadata.spec.ts` reads every moved path with no redirect followed and
checks the `301` and the `Location`. slashslash.build fetches a few files from this repo at a pinned
commit (the hero shots and `src/content/hero.json`, `public/report.png`, `public/favicon.svg`,
`public/fonts/`, `docs/capabilities/data.json`, `apps/web/github-app/manifest.json`); keep them where
they are.

The pages are drawn from the repo's own files, read when the site is built, so the site says what
the code says at that commit:

| Page | Source |
| --- | --- |
| `/docs`, `/docs/<page>` | `docs/cli.md` cut into grouped pages by `src/content/docs-map.ts`, `docs/getting-started.md`, and the pages under `docs/tutorials/` and `docs/ci/` |
| `/self-host` | `apps/web/SELF-HOST.md` |
| `/security` | `SECURITY.md` |
| footer | the README's trademark line, written out in `src/content/trademark.ts` and held to the README by a test |

## The CLI reference, its index and search

`docs/cli.md` is the reference. Each H2 opens with one sentence on what the section is for and one
working example, then the flags; the long sections are cut into pages at the H3s listed in
`src/content/cli-pages.ts`. Three things are generated from it at build time, so they cannot drift:

- **`/docs/cli`**, the command index (`src/content/cli-index.ts`): every command in one line, the
  page that owns it and a flag table per command, read from the synopsis blocks. A test compares the
  commands with `COMMANDS` in `packages/cli/src/run.ts` and fails when one is missing.
- **`/search-index.json`**, the search index (`src/content/search-index.ts`, served by
  `src/routes/search-index[.]json.ts` and prerendered to a static file): a record per heading, with
  its text and the exact error strings, for every docs page and `/self-host`. The box in the docs
  rail (`DocsSearch`) fetches it from this origin the first time it is used and queries it in the
  browser (`src/content/search.ts`). It needs no service and no dependency: the e2e test
  types an error message and asserts that no request leaves the origin.
- **Edit on GitHub** and **copy** on code blocks: every docs page links its source file.

A page that can exit non-zero (`exits: true` in `docs-map.ts`) links the exit codes page. No ticket
id reaches a rendered page: `stripTicketIds` removes them from the markdown at render time, and a
test fails if one gets through; `docs/cli.md` keeps them.

## What a search engine and a link preview read

Every page's title and description are in `src/content/pages.ts`; a docs page's description is the
first paragraph of its own text (`describePage` in `src/content/docs.ts`). `src/content/seo.ts` turns
them into the head: the description, the canonical URL, the Open Graph and Twitter tags. All pages
share one card, `public/social-card.png`, drawn by `bun scripts/social-card.ts`; rerun that when the
headline or the demo's shot changes. `/sitemap.xml` is prerendered from the same page lists
(`src/content/sitemap.ts`), and `public/robots.txt` names it. `wrangler.jsonc` sets
`html_handling: "drop-trailing-slash"` so the slashless address the canonical names answers 200, not
a redirect. `e2e/metadata.spec.ts` checks all of it on every page, and `e2e/a11y.spec.ts` runs axe on
every page in both themes.

## The type face

One sans face on every page, light and dark: Inter, variable, served from this origin. The file is
`public/fonts/inter-latin-wght-normal.woff2` (the Latin subset of `@fontsource-variable/inter` 5.3.0)
and its licence, the SIL Open Font License 1.1, ships beside it as `public/fonts/OFL.txt`. The
`@font-face` and the `--font-sans` stack are in `src/styles.css`, the preload in `src/routes/__root.tsx`.
The e2e run asserts that every page requests the font from the site's own origin, that it loads, that
the browser drew the heading and body text with it, and that nothing else leaves the origin.

## Before the app opens

No link may lead where a visitor cannot follow. Two switches in `src/content/links.ts`:

- `REPO_PUBLIC`: links to the GitHub repository, its files and its images. `true` since the
  repository opened (PS-292). Off, they are drawn as text and the site says the source opens at launch.
- `APP_LIVE`: links to `app.pixelslash.dev`. `false`: there is no Sign in link.

Flip one, rebuild and deploy. The smoke test checks that nothing links to the app while it is off,
so it needs the same change.

## Run it

```bash
bun run dev              # vite dev on :3100
bunx moon run site:build     # prerenders every page into dist/client
bunx moon run site:test      # the docs pages against their source files
bunx moon run site:test-e2e  # Playwright on the build, desktop and phone (CI runs `-- --project desktop`): nav, footer, dead links,
                         # WCAG AA contrast in both themes (e2e/support/contrast.ts): every text node on a solid ground,
                         # and the inner pages' heading and lead over the aurora, read from pixels. Text on a
                         # picture or gradient fill is not measured, every `copy` button,
                         # and the 301 of every moved page
```

`SITE_SHOTS_DIR=<dir> bunx moon run site:test-e2e` also writes a full-page screenshot of every page.

## Deploy

One command, from `apps/site`, with a Cloudflare API token for the account that holds the
`pixelslash.dev` zone in `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`):

```bash
bun run build && bunx wrangler deploy
```

`wrangler.jsonc` attaches the Worker to `pixelslash.dev` as a custom domain (`workers_dev` is off),
so the deploy creates the hostname's DNS record itself. `bunx wrangler deploy --dry-run --outdir
<dir>` builds the upload without sending it.
