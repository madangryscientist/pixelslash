# apps/web — the PixelSlash review app

TanStack Start on Cloudflare Workers, D1 via Drizzle, R2 for the shots, GitHub sign-in. CI uploads
builds with `pixelslash upload`; people review them here.

To run your own: [`SELF-HOST.md`](SELF-HOST.md), from an empty Cloudflare account (or a box on your LAN) to a first upload.

## Self-host in 5 minutes

One Docker image runs the app and the diff worker, with real GitHub sign-in. Everything is kept in one
volume: the database (D1, a SQLite file), the shots (R2, files) and two generated secrets. You need
Docker with Compose and a GitHub account. There is no Cloudflare account and nothing is pulled from a
registry: the image is built from this checkout.

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps). Set its homepage
   to the URL people will open, e.g. `http://localhost:3000`, and its callback URL to that URL plus
   `/auth/github/callback`.
2. From the repo root:

   ```bash
   cd docker/self-host
   cp .env.example .env        # fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
   docker compose up -d        # builds pixelslash-self-host:local, then serves on :3000
   ```

3. Open the URL, sign in with GitHub, and create an org, a project and a token. Then upload from CI
   or a shell with `PIXELSLASH_TOKEN=<token> pixelslash upload --server <URL> --branch main`.

What it does (`deploy/docker/start.ts`, `docker/self-host/`):

- The app is the production build on Miniflare, as on [the LAN box](#run-it-on-the-proxmox-server), through
  the same `deploy/ssh/serve.ts` options. Its `Db` and `orgBlobs` are the Cloudflare ones, backed by
  files under `/data/state/v3`, so the code is the hosted app's.
- On every start it applies any pending `drizzle/` migration before it listens. It records each one
  in wrangler's `d1_migrations` table, so `wrangler d1 migrations apply DB --local --persist-to
  <volume>/state` agrees with it.
- New projects diff on the server (`DEFAULT_DIFF_LOCATION=server`). The diff worker
  (`deploy/ssh/diff-sidecar.ts`) runs in the same container on 127.0.0.1:4181 and is restarted if it
  exits.
- `IMAGE_SIGNING_SECRET` and `MODEL_KEY_SECRET` are generated into `/data/secrets` on the first start,
  unless `.env` sets them. A restart keeps them, and with them the signed image URLs and the sealed
  model keys.
- Any other name in [SELF-HOST.md's Variables table](SELF-HOST.md#variables) can go in `.env`. A
  production build still refuses a GitHub other than github.com.
- Nothing is fetched from Cloudflare at start (`cf: false`).

`docker compose down` keeps the volume. `docker compose down -v` deletes every org, build and shot.
To update, `git pull` and then `docker compose up -d --build`.

The same image is proven by `bun run test:e2e:docker` (in `apps/web`; it needs Docker, so it is not
part of `test:e2e`):

- The e2e build signs in against the GitHub stand-in, makes an org, a project and a token, and takes
  two CLI uploads, which the server diffs.
- It then restarts the container and checks that the builds, the session, the stored PNG and a new
  diff against the stored baseline all survived.
- The production build is checked to send `/auth/github` to github.com with the configured client id.

## Secrets

A deployment sets these with `wrangler secret put <NAME>` (or in `.dev.vars` locally; the names are
in `.dev.vars.example`). Never in git.

| Secret | What it is |
| --- | --- |
| `GITHUB_CLIENT_SECRET` | The GitHub OAuth app's secret, for sign-in. |
| `GOOGLE_CLIENT_SECRET` | Optional (PS-274): the Google OAuth client's secret. With `GOOGLE_CLIENT_ID` (a var in `wrangler.jsonc`), the sign-in page shows "Sign in with Google"; with either unset there is no button and `/auth/google` is a 404. The client is a Google Cloud "OAuth client ID" of type Web application, with the redirect URI `https://<host>/auth/google/callback` (and `http://localhost:3000/auth/google/callback` for `vite dev`). |
| `IMAGE_SIGNING_SECRET` | Signs the short-lived image URLs. |
| `MODEL_KEY_SECRET` | Base64 of 32 random bytes (`openssl rand -base64 32`). Seals each project's model API key at rest with AES-256-GCM (stored as `v1:<iv>:<ciphertext>`). Unset, saving a model key fails with "MODEL_KEY_SECRET is not set" and a stored key is not read, so builds are reviewed as plain pixels. A key saved before this existed is plain text until the project's model settings are next saved. Changing the secret makes the keys sealed under the old one unreadable: enter each key again. |

The `e2e` env in `wrangler.jsonc` carries fixed test values for these; they are not secrets. `env.production` lists none of them: [Deploy to Cloudflare](#deploy-to-cloudflare-apppixelslashdev) sets each with `wrangler secret put`.

## Hardening for a deployment strangers sign in to (PS-250)

On by default; `SECURITY.md` says why each exists.

| Setting | Where | Meaning |
| --- | --- | --- |
| `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS` | `wrangler.jsonc` vars (`1` under `env.e2e`) | Empty (the default): a project's or org's model base URL on loopback, RFC 1918, link-local, CGNAT, their IPv6 forms, or a `.local`/`.internal`/single-label name is refused at save and before each call, after resolving the name (`src/ai/model-host.ts`). `1` lets them through, for a self-host running its own model; the LAN CT's helper on loopback needs it. Never set it on a deployment strangers can sign in to. |
| `GITHUB_OAUTH_BASE`, `GITHUB_API_BASE` | `wrangler.jsonc` vars | A production build refuses to start unless they are `https://github.com` and `https://api.github.com` (`src/auth/stub-guard.ts`). Only `vite dev` and the `CLOUDFLARE_ENV=e2e` build may point at the GitHub stand-in. |
| `GOOGLE_OAUTH_BASE` | `wrangler.jsonc` vars | Empty, Google's own endpoints. A production build refuses to start when it is set; only the Playwright run points it at the stand-in, which answers as a Google account too. |
| `API_RATE_LIMIT`, `SIGNIN_RATE_LIMIT` | `wrangler.jsonc` `ratelimits` | Cloudflare rate-limit bindings: `/api/v1/*` per token (a refused token per client IP), 3000 a minute; `/auth/github`, `/auth/google` and their callbacks per client IP, 30 a minute. Over the limit is a 429. Not under `env.e2e`, so the e2e build and the LAN CT run with the no-op seam in `src/server/rate-limit.ts` and are never limited. |

## Error reporting to Sentry (PS-227)

Optional, and off until a DSN is set. With no `SENTRY_DSN` the Worker is not wrapped, the browser is
never told a DSN (so the reporter's chunk is never fetched) and no request goes out for it.

| Var | Where | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | `.dev.vars` / `wrangler secret put` / the CT's `.dev.vars.e2e` | The Sentry DSN. Server and browser both use it (a DSN is public by design: it can only send events). |
| `SENTRY_RELEASE` | `wrangler.jsonc` vars; `update.sh` | The deployed sha. `update.sh` stamps it on the CT; the e2e build leaves it empty, so the health page says it is not stamped (the Playwright run sets `e2e`). |
| `SENTRY_ENVIRONMENT` | `wrangler.jsonc` vars; `update.sh` | `lan` on the CT, `e2e` under the e2e runs, `dev` otherwise. |

**What is reported.** On the server (`@sentry/cloudflare`): an error the Worker lets out, an `/api/v1`
failure that becomes a 5xx (failed uploads and finalizes), a failed shot or build diff, and a diff
sidecar failure (`src/diff/sidecar.ts`; the sidecar is a Bun process, but only the Worker talks to
it, so the Worker reports its failures). In the browser (`@sentry/react`): an uncaught error and an
error that reaches a route's error component. Server-function errors are turned into a response by
TanStack Start before the Worker's wrapper sees them, so they are not reported on the server: one
that breaks a page reaches the browser's error component and is reported there. Tracing is off
(`tracesSampleRate` 0), there is no session replay, no profiling and no breadcrumbs.

**Why `@sentry/cloudflare`.** It is the SDK for the runtime (workerd, here under Miniflare), and
Sentry's TanStack Start docs use it with `withSentry` on Workers. `@sentry/tanstackstart-react` is
in beta and its server setup does not run on Cloudflare. All three SDKs are 11.9.0, MIT.

**Privacy.** Every event passes `scrubEvent` (`packages/engine/src/sentry-scrub.ts`, shared with the
CLI): bodies, cookies, query strings, auth headers, tokens and image data are dropped, and the user
and breadcrumbs are removed. `src/server/sentry.test.ts` and `e2e/sentry.spec.ts` assert it against a
local fake ingest.

**Deploy.** The CT keeps the DSN in `apps/web/.dev.vars.e2e` as `SENTRY_DSN=…`. `release.sh` can
also carry it: with `PIXELSLASH_SENTRY_DSN` set, it goes into the tarball as a mode 600
`.sentry-dsn` (never on a command line, never printed), and `update.sh` saves it into the CT's
`.dev.vars.e2e` and deletes the carried file. `update.sh` then stamps the release's own
`SENTRY_RELEASE=<sha>` and `SENTRY_ENVIRONMENT=lan` into its `.dev.vars` (only when a DSN is set).

**To switch it on (one time):**

1. Create a project in sentry.io (platform: Cloudflare Workers or JavaScript) and copy its DSN.
2. Keep it in a secret store; set the variables any way you like.
3. Deploy with it: `PIXELSLASH_SENTRY_DSN=<dsn> apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"`
   (the same command as the deploy above). Or put `SENTRY_DSN=<dsn>` in the CT's
   `apps/web/.dev.vars.e2e` and deploy the current sha again.
4. For the CLI, set `PIXELSLASH_SENTRY_DSN` where it runs (CI secrets); see "Error reporting" in [`docs/cli.md`](../../docs/cli.md).

## Operator health (`/_admin`, PS-330)

A read-only page for the people who run the deployment: builds by status, the oldest in flight, every
build stuck past `STALE_PROCESSING_MS`, the last 24 hours and 7 days (outcomes, errored builds grouped by
the first words of their error, p50 / p95 / p99 of wall time and each step, and the newest builds'
snapshots, compares and compare times, cache hits counted apart and timed nowhere; and, over the
whole window, snapshots per build and time per snapshot as p50 / p95 / p99 with their `n`, the server's
compares only: a CI build's times sit in `builds.timings` and reading them would read every build of
the window), the release commit, the newest
migration the database reports against the ones the code carries, and row counts. Set
`PIXELSLASH_ADMIN_LOGINS=login1,login2` (GitHub logins, case-insensitive). The page is a 404 for
everyone else, signed out or not, and when the variable is unset; nothing links to it. The LAN stub build lists nobody (every visitor there signs in as `e2e-octocat`), so set `PIXELSLASH_ADMIN_LOGINS` in its `.dev.vars` to open the page. A figure that
cannot be read (R2's total, failed summary calls) says "unavailable" and why instead of a 0.

## Retention (PS-239)

Off unless you set it. `PIXELSLASH_RETENTION_DAYS=30` (a whole number above 0; anything else is off)
makes the review app expire PR builds: a build older than that window, on a branch that is not the
project's default branch, is deleted with its blobs (R2, or the self-host's bucket) and its rows.
Default-branch builds are never deleted. Neither is a build a surviving build still points at as its
baseline (`baselineKey`, `mainBaselineKey`, `baselineSnapshotId`, `carriedFrom`, and a removed marker's
`image_key` / `baseline_key`), followed through the builds that are kept, so a chain only goes once
nothing live reaches it. Flake evidence of a deleted build goes too; the flake itself stays. Usage
counts drop with the builds. With retention on, a PR build's page says "expires in N days".

- **Dry run first.** The Worker's hourly cron (`triggers.crons` in `wrangler.jsonc`) does nothing
  without the window, and with it only logs `retention dry run: would delete ...` until
  `PIXELSLASH_RETENTION_DELETE=true` is also set. Each sweep takes the oldest 100 builds, so a backlog
  clears over several runs.
- **From the command line, for a self-host** (reads the Miniflare state on disk, a dry run unless
  `--apply`):

  ```bash
  bun deploy/retention.ts --days 30                  # list the builds and bytes; deletes nothing
  bun deploy/retention.ts --days 30 --limit 100      # the oldest 100 only
  bun deploy/retention.ts --days 30 --apply          # delete them
  ```

  `--days` defaults to `PIXELSLASH_RETENTION_DAYS`, and with neither it refuses. `--persist-to` is the
  state directory (`.../state/v3`), by default `$PIXELSLASH_DATA_DIR/state/v3` or
  `.wrangler/state/v3`. Stop the server before `--apply`: a build uploaded while the sweep runs can
  point at a baseline the sweep has just chosen to delete, which no lock prevents.
- Deletion is permanent; read a dry-run listing before turning it on. Enabling it on a server with real
  data is the operator's decision.

### Abandoned builds (PS-324)

Always on, with no setting. A build still `uploading` or `processing` whose last activity is older than
6 hours is ended at `errored` with the reason `no activity for 6 hours: the uploader or its run went away;
send the build again`, so a build whose uploader went away stops counting as in flight. Last activity is the
latest of the build's creation, its `processingStartedAt` and its newest shot's upload. Only `status` and
`error` are written: nothing is deleted and no time is recorded, so an ended build is never in the timing
numbers. Sending finalise again resumes a server-diff build, as for any `errored` build; a CI-diff project's gets the
409 that build recovery gives, and a build that never finalised is completed only by sending it again. The hourly cron runs the sweep for
every project; a self-host fires no cron, so there a project is swept only when it next creates a build.

## GitHub check runs (PS-23)

Optional. A project connected to a GitHub repo (project settings → GitHub repo) gets a
**PixelSlash** check run on each build's commit: failing while changes await review or one is
rejected, passing once every change is accepted or nothing changed, updated in place as the build
is reviewed. A build of a pull request also keeps one comment on the PR, edited in place on each
build (below). It needs the GitHub App: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (a secret) and
`PIXELSLASH_PUBLIC_URL` for the link. Without both App vars nothing calls GitHub. `GITHUB_APP_API_BASE`
(PS-281) is the App's own API base; empty, the App uses `GITHUB_API_BASE`. The LAN self-host sets it to
`https://api.github.com` (`release.sh` carries it with the App id) while sign-in stays on the stub. Registering the
App, its permissions and deploying its key: [`github-app/README.md`](github-app/README.md).

### The pull request comment (PS-82)

A build uploaded for a PR (`prNumber`) gets one comment on it, edited in place by every later build
of the PR: the model's summary or "Summary skipped", the counts, the three to five most changed shots
as links, and the build page link. Text and links only; no screenshot goes to GitHub. It is sent
with the same client as the check run (the App, or the token), only to the project's connected repo,
and only when the project's "Comment on pull requests" setting (on by default) is on. A failed
comment call is logged and never changes a build's verdict. The App needs `pull_requests: write`
(`github-app/README.md`).

### Without the App: a commit status with a token (PS-235)

A self-host that has not registered the App can post the same verdict as a **commit status**,
context `PixelSlash`, with a fine-grained personal access token. The states are the check run's:
`pending` while the build is diffed, `failure` while a change awaits review, a shot is rejected or
the build errored, `success` once every change is accepted or nothing changed. A status has no
body, so it carries only the one-line title and the link to the build page; each state change is a
new status on the commit and GitHub shows the latest.

- **Token scope.** Create a fine-grained token (GitHub → Settings → Developer settings → Personal
  access tokens), resource owner = the account or org that owns the repos, repositories = only the
  ones whose projects you will connect, repository permissions **Commit statuses: Read and write** and, for the pull request
  comment, **Pull requests: Read and write** (GitHub adds the read-only Metadata permission itself).
  Nothing else.
- **Where the secret lives.** `GITHUB_STATUS_TOKEN`, a secret and never a var: `wrangler secret put
  GITHUB_STATUS_TOKEN` on Cloudflare, `.dev.vars` for `vite dev`, and the CT's `.dev.vars.e2e` on the
  LAN self-host (`release.sh` does not carry it; a release keeps the lines it did not write). The
  Docker self-host reads it from the container's environment.
  `PIXELSLASH_PUBLIC_URL` sets the link, as above.
- **Precedence.** The App is used when it is configured; the token only when it is not. With
  neither, nothing calls GitHub. Connect each project to its repo as for the App (project settings
  → GitHub repo).

## Run it locally as a project's server

A local server is a real PixelSlash server: a CLI pointed at it uploads, the server diffs, and the
build page is reviewed in a browser. Nothing leaves the machine and no Cloudflare account is used:
D1 and R2 are miniflare's, kept in `apps/web/.wrangler/state` (gitignored) across restarts.

Sign-in uses the `e2e` environment in `wrangler.jsonc` and the GitHub stand-in the e2e suite runs
(`e2e/github-stub.ts`): every visitor signs in as `e2e-octocat`. That is fine for one person on
their own machine and nothing more.

From `apps/web`, after `bun install` at the repo root:

```bash
# 1. Migrate the local D1 (once, and again after a pull that adds a migration).
bunx wrangler d1 migrations apply DB --local --env e2e

# 2. The GitHub stand-in, on :4174. Leave it running.
bun e2e/github-stub.ts &

# 3. Serve the app with the e2e vars on :3000.
CLOUDFLARE_ENV=e2e bun run dev -- --host 127.0.0.1 --strictPort
```

This is the dev server, so changes to the app reload without a rebuild. The server diff runs under
it as it does in a build; to serve the production build instead, `CLOUDFLARE_ENV=e2e bun run build`
then `HOST=127.0.0.1 bun deploy/ssh/serve.ts` (the LAN self-host's server, below; `PORT` moves it off :3000).
`bunx vite preview --host 127.0.0.1 --port 3000 --strictPort` still serves the same build.

`bunx nx test:e2e web` (and `bun run test:e2e:dev`) does not use :3000 or :4174: `e2e/ports.ts` picks two
free ports per run, so two runs from two worktrees can go at once. Set `PIXELSLASH_E2E_PORT` and
`PIXELSLASH_E2E_STUB_PORT` to pin them. Each run builds and keeps its D1 under its own worktree's
`.wrangler/e2e`, and turns the Workers debugger port off (it probes from 9229 and two runs at once
both get it).

Then, in a browser at `http://127.0.0.1:3000` (use one host throughout: the session cookie is per
host, and the OAuth callback is built from the host you came in on):

1. **Sign in with GitHub.** The stand-in signs you straight in.
2. **Create the org and the project**, e.g. both named `hackcove`.
3. **Issue a CI token** in the project's Settings. It is shown once. Save it to a file outside every
   repo, readable only by you:

   ```bash
   mkdir -p ~/.config/pixelslash
   install -m 600 /dev/null ~/.config/pixelslash/hackcove-local.token
   $EDITOR ~/.config/pixelslash/hackcove-local.token   # paste the psci_… token
   ```

Upload to it from the project's checkout. The CLI reads the commit, branch and merge-base from the
directory it runs in, so run it there by path (not `bun run pixelslash`, which runs in this repo):

```bash
PIXELSLASH_SERVER=http://127.0.0.1:3000 \
  bun ~/dev/pixelslash/packages/cli/src/index.ts upload <snapshot-dir> \
  --token-path ~/.config/pixelslash/hackcove-local.token
```

Every `main` build is accepted without review. A branch build diffs each shot against the newest
accepted one at the nearest of its merge-base and its ancestor commits (up to 200), so `main` needs a build at the
merge-base or any of those ancestors before a branch is reviewed, or every shot on it reads "new".

In hackcove, `bunx nx run storybook:visual-upload` does both: it uploads `origin/main`'s capture as
`main` (once per main commit and server), then the branch's. It refuses a branch that is not based
on `origin/main`'s tip, a dirty tree and `main` itself.

```bash
PIXELSLASH_DIR=~/dev/pixelslash \
PIXELSLASH_SERVER=http://127.0.0.1:3000 \
PIXELSLASH_TOKEN_PATH=~/.config/pixelslash/hackcove-local.token \
  bunx nx run storybook:visual-upload
```

To start over, stop the server and remove `.wrangler/state`.

## Deploy to Cloudflare (app.pixelslash.dev)

The hosted app (PS-277) is `env.production` in `wrangler.jsonc`: the Worker `pixelslash-web-production` on the
custom domain `app.pixelslash.dev`, D1 `pixelslash` (WEUR), R2 `pixelslash-blobs` and the queue
`pixelslash-explain`, all in the maintainer's account. It is a named env, built with
`CLOUDFLARE_ENV=production`, so the top level keeps its placeholder D1 id and no route: `vite dev`, the
unnamed build, the e2e build and the LAN CT read the same config as before. The Worker's name is
the top level's plus the env, so forgetting `CLOUDFLARE_ENV=production` publishes a different Worker
(`pixelslash-web`) and never overwrites the live one. (For your own account, use
[`SELF-HOST.md`](SELF-HOST.md).) It is still a production build to the stub guard: it refuses to start
pointed at anything but github.com.

Deploy with an API token, not `wrangler login`, so the credentials are scoped and the commands are repeatable.
Create the token in your Cloudflare dashboard under **My Profile → API Tokens → Create Token** (a custom
token), with these permissions:

- **Account** · Workers Scripts: Edit (publish the Worker)
- **Account** · D1: Edit (apply the migrations)
- **Account** · Queues: Edit (bind `pixelslash-explain`)
- **Account** · Account Settings: Read
- **Zone** · Workers Routes: Edit and DNS: Edit on the zone that holds your custom domain (the deploy
  creates that hostname's record; see below)

Scope it to the one account and, for the zone rows, to that one zone. Then set both variables in the shell
you deploy from. The account ID is on the right-hand side of any zone's Overview page in the dashboard:

```bash
export CLOUDFLARE_API_TOKEN='<the token you just created>'
export CLOUDFLARE_ACCOUNT_ID='<your account ID>'
```

R2 bucket admin (creating or deleting `pixelslash-blobs`) is a separate job and needs a token with
**Account** · Workers R2 Storage: Edit. The deploy only binds the bucket, so keep that token out of the deploy shell.
From `apps/web`:

```bash
CLOUDFLARE_ENV=production bun run build                          # writes dist/ for env.production
bunx wrangler d1 migrations apply pixelslash --remote --env production
bunx wrangler deploy --var SENTRY_RELEASE:"$(git rev-parse --short HEAD)"
```

Build first: `wrangler deploy` ships what `dist/` holds, and a build made without
`CLOUDFLARE_ENV=production` is the top level's (placeholder D1 id, no route, no `app.pixelslash.dev`).
Apply migrations before the deploy that needs them; the migration step is the only one that changes
the database. `wrangler deploy --dry-run --outdir "$TMPDIR/ps-web-dry"` after the build prints the
bindings (the D1 id, the bucket, the queue, the vars) and exits without deploying; the route is in
`dist/server/wrangler.json`.

Wrangler warns that `IMAGE_SIGNING_SECRET` and `SENTRY_DSN` exist at the top level but not in
`env.production.vars`. That is on purpose: a var and a secret of one name clash, and an empty var
would shadow the secret, so `env.production` lists no secret at all. Set each once, from `apps/web`:

```bash
openssl rand -base64 32 | bunx wrangler secret put IMAGE_SIGNING_SECRET --env production
openssl rand -base64 32 | bunx wrangler secret put MODEL_KEY_SECRET --env production
bunx wrangler secret put SENTRY_DSN --env production            # optional: off while unset
bunx wrangler secret put GITHUB_CLIENT_SECRET --env production  # with GITHUB_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET --env production  # with GOOGLE_CLIENT_ID
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --env production # with GITHUB_APP_ID
```

`IMAGE_SIGNING_SECRET` is required (without it every signed image URL fails); `MODEL_KEY_SECRET` is
base64 of 32 bytes and, once projects have sealed keys, must not change (see [Secrets](#secrets)).
`GITHUB_CLIENT_ID` and `GOOGLE_CLIENT_ID` are vars, set in `env.production.vars` (both are public OAuth
client ids; the secrets above are the other half). `GITHUB_APP_ID` is a var too: `5528217`, the App "PixelSlash Review"
(PS-234, slug `pixelslash-review`), whose key is the `GITHUB_APP_PRIVATE_KEY` secret. While either half of a sign-in is empty it is off (no button, `/auth/<provider>` a 404).

**Do not make a DNS record for `app.pixelslash.dev` by hand** (not a CNAME, not an A record, not
in the dashboard). `custom_domain: true` makes Cloudflare create the record and the certificate during
`wrangler deploy`; a record that already exists makes that deploy fail ("hostname already has
DNS record"), and deleting it is a step on a live zone. The route names only `app.pixelslash.dev`, so
a deploy never touches the apex (the marketing site) or any other record.

## Run it on the Proxmox server

The same local server, on a Proxmox host instead of your machine, so the dashboard is up without
anything running here. It is **LAN only**: sign-in is still the GitHub stand-in, so anyone who can
reach the address signs in as `e2e-octocat` and sees every org. No port forward, no tunnel, no
public DNS. Real GitHub sign-in is a later ticket.

| | |
| --- | --- |
| Dashboard | `http://<ct-address>:3000` |
| Stand-in | `http://<ct-address>:4174` (the browser is sent there to sign in) |
| Container | CT `$CT` `pixelslash` on the Proxmox host `$SSH_HOST`: Debian 13, unprivileged, 2 vCPU, 6 GiB, 10 GB on `local-lvm`, starts on boot. The address is static in the CT config, below the router's DHCP pool. |
| Releases | `/home/pixelslash/releases/<sha>/`, user `pixelslash`, one per deploy, built on the machine that deploys; `releases/current` is the one serving. The last 3 are kept. Bun is in `~pixelslash/.bun`, Node 24 (for wrangler) in `/usr/local`. |
| Old checkout | `/home/pixelslash/pixelslash`, the git checkout the CT served from and built in before PS-225. Nothing runs from it now; it holds the state and the secrets below. |
| State | D1 and R2 in the old checkout's `apps/web/.wrangler/state` on the CT's disk; every release's `apps/web/.wrangler/state` links to it, so it is kept across restarts, deploys and rollbacks. |
| Units | `pixelslash-stub` (`bun e2e/github-stub.ts`) and `pixelslash-web` (`bun deploy/ssh/serve.ts`: the production build on Miniflare, no vite), from `deploy/ssh/`, in `releases/current/apps/web`. `pixelslash-diff` (`bun deploy/ssh/diff-sidecar.ts`, the diff sidecar below) runs beside them. All three restart on failure and start on boot. With the opencode switch on (below) a fourth, `pixelslash-opencode`, runs the same way. `pixelslash-watchdog.timer` restarts `pixelslash-web` or `pixelslash-diff` when one is active and silent (below). |

`deploy/ssh/serve.ts` calls Miniflare's API on the build (`dist/server` is the Worker, `dist/client` the
assets): the D1 and R2 in `.wrangler/state/v3` that `vite preview` kept, the `wrangler.json` vars with
`.dev.vars` over them, the explain queue. It listens on `0.0.0.0:3000`; `HOST` and `PORT` move it (the
Rust front door of PS-217 will set `127.0.0.1` and `3001`). It does not migrate or build: the deploy does.

The build is the `e2e` environment's with three values replaced. `apps/web/.dev.vars.e2e` on the CT
(mode 600, gitignored, never in git) sets `GITHUB_OAUTH_BASE=http://<ct-address>:4174`, so the
browser on another machine is sent to the stand-in at the CT's address rather than its own
`localhost`, a random `IMAGE_SIGNING_SECRET`, and the deployment's `MODEL_KEY_SECRET` (without it
the CT would seal keys under the `e2e` env's fixed test value). It lives in the old checkout and never
leaves the CT: the build runs on the deploying machine, which ships no `.dev.vars`, and the deploy copies the
CT's file into the release's `dist/server/.dev.vars` (mode 600), where `serve.ts` reads it. The `e2e`
env in `wrangler.jsonc`, and so the tests, are unchanged.

**Deploy (PS-225): the CT never builds.** A build beside the running workerd did not fit in the
CT's memory, so the build runs on the deploying machine and the CT gets the result. From a clean checkout of
the commit (main, after the merge):

```bash
PIXELSLASH_LAN_SSH=root@$SSH_HOST PIXELSLASH_LAN_CT=$CT PIXELSLASH_LAN_SSH_KEY=~/.ssh/<key> \
  apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"
```

`release.sh` refuses a sha that is not `HEAD` or a tree that is not clean, runs
`CLOUDFLARE_ENV=e2e bun run build`, packs the commit's tracked files (without `bench/`) and
`dist` into one tarball, sends it over ssh to the Proxmox host and in with `pct push`, and runs that
release's own `deploy/ssh/update.sh` in the CT. The host, the CT and the key come only from those
variables (`PIXELSLASH_LAN_SSH_KEY` is optional); nothing is hard-coded. It is not run automatically.

On the CT, `update.sh` unpacks the release into `releases/<sha>` beside the one serving, installs it
(`bun install --frozen-lockfile --production`) and runs the D1 migrations (additive only), then
points `current` at it and restarts the units. **The downtime is that restart only.** A release that
does not come up on :3000 goes back to the previous one by itself and is deleted; the script's header
and comments have the details. A sha still kept on the CT (the last 3) is switched to without
unpacking it again, so deploying the current sha applies a changed opencode switch or
`.dev.vars.e2e`, and deploying an older one from a clean checkout of it is the rollback by hand.
wrangler is a runtime dependency of `apps/web` so the production install has it for the migrations.

**A deploy does not run under a live build (PS-228).** The restart kills the Worker mid-diff and the
migration can hold the D1 file's write lock, so a build being diffed at that moment ended `errored`
(a deploy during an upload did exactly that). Before it changes anything, `update.sh` asks the
serving release's D1 for builds that are `processing` and began within the last 15 minutes. Any
makes it exit 1 with the build ids and `nothing changed`; run it again once they end. A build
`processing` for longer is an orphan (the run died with its Worker; 7a698500 was one) and never
blocks. If the D1 cannot be read the deploy stops too, since not knowing is not a go-ahead. To
deploy anyway: `PIXELSLASH_DEPLOY_FORCE=1 apps/web/deploy/ssh/release.sh …` (`release.sh` carries it
into the CT). The first release on a CT has no serving D1 to ask and skips the check.

The Worker also rides out a short lock itself: `database()` (`src/server/env.ts`) wraps the D1
binding in `retryBusy` (`src/db/busy.ts`), which runs a statement again on `SQLITE_BUSY` / `database
is locked` after 25, 50, 100 and 200 ms (five tries, about 375 ms) before the error stands. A busy
statement did not run, so a repeat is safe. A lock held longer still ends the build `errored`, and
the build's `error` names the SQLite cause, not only drizzle's `Failed query`. The CLI treats an
`errored` build at the end of `upload` as an upload failure (exit 1, `UPLOAD FAILED: build <id>
errored on the server: <reason> (<build page>)`), so CI no longer passes a build nobody diffed.

**workerd's memory (PS-155).** A day of `/workerd-rss.log` samples (every 10 min, 2026-10-23 to 25) shows workerd at 127-140 MB idle
and stepping to 1.5-1.8 GB (peak 1.82 GB) within one 10-minute sample of an upload burst (the snapshot PUTs and `finalize`),
then holding there for hours until the unit restarts, which brings it back to 130 MB. It does not grow without bound, but it
does not give the memory back, and with `vite preview` (~0.5 GB) beside it the peak was more than the CT's 2 GiB: that was the
two OOM kills of 2026-10-25. `pixelslash-web` has run `deploy/ssh/serve.ts` since PS-220 instead, which takes about 450 MB
out of the unit at idle and after a burst (`perf/README.md`, desktop A/B). `pixelslash-web.service` carries `MemoryMax=2500M`
and `OOMPolicy=stop` ("Memory limits and the watchdog", below); every deploy installs the release's unit, so the cap survives
an update.

Logs: `pct exec $CT -- journalctl -u pixelslash-web -f`. Point a project's upload at it with
`PIXELSLASH_SERVER=http://<ct-address>:3000` and a token issued in its Settings on the CT. A token
works only on the server that issued it, so keep one token file per server (the local one and the
CT's are different tokens).

The diff runs inline in the finalise request with a 25 s budget (`DIFF_BUDGET_MS`), which stands in
for a Worker's CPU limit. On the CT's 2 vCPU a build of hackcove's 145 shots measures about 126 and
then stops at the budget: the build reads `errored` and names how many shots are left. A finalise
sent again resumes (it keeps what was measured and diffs the rest), and `pixelslash upload` sends it
again by itself while the count falls, so the build ends with all 145 measured and its real verdict.

### The diff sidecar

In-process the server diff is the engine's `diff.wasm`, the CLI's diff (PS-210; there is no pngjs
diff and no switch). On the self-host the Worker instead sends each
shot's two PNGs to a Bun process on the same box: `deploy/ssh/diff-sidecar.ts`, unit
`pixelslash-diff`, on `127.0.0.1:4181`. It runs the engine's own `diffPngs` (the same `diff.wasm`) with the same
options and ignore areas, and answers with the result and the overlay, so the verdict, the counts,
the regions and the overlay's bytes are the same as in-process (`src/diff/sidecar.test.ts` holds
this on a `bench/corpus` pair and the e2e fixtures). It stays because it keeps a burst's diffs
out of `pixelslash-web`'s memory: on the RSS burst (`e2e/rss-burst.spec.ts`, workerd and vite together)
PS-210 measured the in-process diff at a 1519–1588 MB peak and 1124 MB with the sidecar.

`DIFF_SIDECAR_URL` names it, in `wrangler.jsonc`'s `env.e2e` vars only, so the CT build and the
production e2e run use it (that run starts a sidecar of its own on a free port;
`PIXELSLASH_E2E_NO_SIDECAR=1` runs it without one). `test:e2e:dev` starts none, so the in-process diff
stays under an e2e run. The Cloudflare deploy never sets it and never runs a sidecar. Only a
loopback URL (`127.0.0.1`, `localhost`, `[::1]`) is used; any other is refused, so a typo cannot send
shots off the box. When it is unset, refused, down, times out (15 s) or answers with an error, the
shot is measured in-process (the same `diff.wasm`), and the reason is
logged once per kind, not once per shot.
After the first shot it cannot reach, the rest of that run skips it, so a hung sidecar costs one
timeout, not one per shot. A PNG the sidecar cannot decode is measured in-process too, without a log
line, so the diff reports it in its own words as on Cloudflare; over the 12.5 Mpx limit below it gets
that limit's message instead.

**One call at a time (PS-325, `src/diff/sidecar.ts`).** The sidecar's diff is synchronous, so it
answers one call at a time and a caller also waits for every call ahead of it. The web process keeps
that queue itself: a call waits for its turn first, and its 15 s starts only then, so a busy sidecar
is not taken for a down one. The wait still counts against the run's diff ceiling: a run that spends
its budget waiting stops with shots left, and the next finalise carries on. The ceiling is checked
between shots and a queued call cannot give up, so one finalise can outlast 25 s by its queue. A hung
sidecar's timeouts now come in turn: with four runs waiting, the last falls back after a minute, not
15 s. The queue survives a request cancelled mid-call (a lease, `src/diff/call-gate.ts`).

**Pixel limits (PS-323, `src/diff/compare.ts`).** With a sidecar configured, a shot over 24.5 Mpx
(1280x19140) is not diffed at all, and one over 12.5 Mpx (1280x9765) is not diffed in-process after
the sidecar failed, so a sidecar timeout cannot add a tall diff to workerd's memory. The size comes
from the PNG's header. Such a shot keeps the reason in its `diffError`, and the build ends `errored`
naming it: `too large for an in-process diff without the diff sidecar: 1280x16800 = 21.5 Mpx,
limit 12.5 Mpx`. A deployment with no sidecar, Cloudflare included, has neither limit and keeps the
diff ceiling above.

```
server diff: in-process (unreachable): http://127.0.0.1:4181/v1/diff: Unable to connect...
```

The shots go over loopback to a process bound to 127.0.0.1 and nowhere else; nothing is written to
disk (invariant 4). A deploy installs and restarts the unit before `pixelslash-web` starts, and a
sidecar that does not come up is a warning, not a rollback: the Worker measures in-process. Logs,
one line per diff with its time: `journalctl -u pixelslash-diff -f`.

### Memory limits and the watchdog

On 2026-11-05 a tall upload left `pixelslash-web` and `pixelslash-diff` in D state over their
`MemoryHigh`, with swap full: port 3000 accepted connections and answered nothing, nothing was
killed, and systemd read `active` with `NRestarts=0`. Held locally to the sidecar's limits and fed
1280x16800 diffs, the sidecar wedged the same way and stayed wedged past 270 s (PS-323). So:

- **No `MemoryHigh` and no swap on either unit.** Over `MemoryMax` the kernel kills the process, the
  unit fails, and `Restart=` brings it back. The same overload with no High was killed within seconds.
- **The limits rest on these numbers**, measured locally under `MemorySwapMax=0`, on synthetic
  busy PNGs. The sum of the Maxes, with `pixelslash-opencode`'s 500M, is 4000M of the CT's 6 GiB. The
  Proxmox host is overcommitted, so the limits are ceilings, not reservations.

| Unit | `MemoryMax` | Peak measured |
| --- | --- | --- |
| `pixelslash-diff` | 1000M | Through the server on 7 shots at 1280x16800: 694 MiB with a small change, 783 MiB with every pixel changed. Direct diffs with every pixel changed: 763 MiB at that size and 826 MiB at 1280x19140 (24.5 Mpx), 4.3-4.8 s each |
| `pixelslash-web` | 2500M | 480 and 504 MiB on the same 7 shots; 775 MiB with the sidecar down on 7 at 1280x9500 (12.2 Mpx), ~465 MiB over what it held before the diffs; ~1.6-1.8 GB on the live bursts (ob 1887, PS-155) |

  Those 7 shots took 3.6 s with a small change. With every pixel changed the first finalise stopped at
  the diff ceiling after 5 shots (21.3 s) and the next measured the other 2 (8.5 s): `changes`, 31.9 s.

  Under sustained uploads `pixelslash-web` reaches its Max with page cache (R2's files): at 2505 MiB
  its anonymous memory was ~790 MiB, nothing was killed and `GET /` kept answering.
- **The watchdog.** `pixelslash-watchdog.timer` runs `/usr/local/sbin/pixelslash-watchdog` every 30 s, as
  root: `update.sh` copies `deploy/ssh/watchdog.sh` there, because `pixelslash` owns the releases. It
  asks `GET /` on 3000 and `GET /health` on 4181, with 10 s to answer, and restarts a unit that is
  active and has not answered 4 passes in a row: `journalctl -u pixelslash-watchdog`. Any HTTP
  answer counts as alive, and a unit that is not active is left to `Restart=`. A deploy stops the timer
  for its restarts. It needs `curl` on the CT; `update.sh` stops before changing anything
  without it. `watchdog.test.ts` proves its decisions on a stub; `perf/wedge-check.ts` runs it
  against a really wedged sidecar (`perf/README.md`).

**Known limit.** Three or more uploaders sending tall shots continuously (5.5 MB PNGs, measured with
20 shots to diff) starve the call to the sidecar inside workerd's one thread, whose memory is not the
problem: unlimited memory gave the same result. The 15 s timeout fires. The server keeps answering,
and the build ends `errored` with the ceiling or a limit named; re-run it once the load has passed.
A diff is synchronous, and these times are from a desktop: on a host slow enough that a whole-page change
at this size passes the 15 s timeout, the sidecar is skipped for that run and the shot errors naming the
12.5 Mpx limit.
Docker (`deploy/docker/start.ts`) has the pixel limits and respawns its sidecar, but sets no cgroup
limits and has no watchdog.

### The AI explain step through opencode

The explain step needs a model, and workerd cannot start a process, so on the CT it reaches the
`opencode` CLI through a helper on the same box: `deploy/ssh/opencode-helper.ts`, unit
`pixelslash-opencode`. It serves one route, `POST /v1/chat/completions` on `127.0.0.1:4180`, in the
shape `complete()` in `src/ai/model.ts` already sends, and answers each call with the engine's
tool-less `opencode run` (no `--auto`, a deny-everything agent, no server). A region's three crops
and the build summary's text-only call both go through it. The images are written to a private temp
dir that is removed when the call ends. It is **off** until you turn it on, and it is for this
personal self-host only: the OpenCode Go plan it uses is for personal use.

```bash
# On the CT, as root: the model (provider/model), then the key.
echo opencode-go/claude-haiku-5-5 > /etc/pixelslash/opencode-helper
install -d -o pixelslash -g pixelslash /home/pixelslash/.config/pixelslash
install -m 600 -o pixelslash -g pixelslash /dev/stdin /home/pixelslash/.config/pixelslash/opencode.key
# Then, on the deploying machine, deploy (the sha already serving is restarted, not unpacked again).
apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"
```

While `/etc/pixelslash/opencode-helper` exists, a deploy (`update.sh` on the CT) checks it and the key file (which must
be mode 600), installs the opencode release the capture image pins, enables the unit, and gives
every non-smoke org without a model a row pointing at `http://127.0.0.1:4180/v1` with a placeholder
key. The real key is only in the token file; the helper puts it in opencode's environment, so it is
never in git, the unit, a log line or a reply. An org or project with a model of its own keeps it
and wins. The rows are written when a deploy runs, so an org created afterwards has no explain
step until the next deploy. Remove the file and deploy again to turn it off: the rows that
point at the helper are deleted and the unit is stopped and removed. With the file never made,
a deploy does nothing about the helper.

The helper runs one call at a time (the CT has no memory for more; the unit is capped at 500 MB)
and gives a call 18 s. One call takes about 4 s. The app sends a shot's regions up to six at a
time, each with a 20 s limit that starts when it is sent, so a shot with more than about four
changed regions has its later calls time out while they wait in the helper's line. The shot then
keeps the notes it did get, is never auto-passed, and is not retried (the explain queue retries
only a shot that got none), so its review is partial. Raising the helper's concurrency means a
bigger memory cap for the unit, and fewer calls at once means a change to the app's fan-out, which
the hosted path shares; neither is done here. The journal has one line per call, with the model,
the image count, the time and the outcome (a named reason only, never opencode's own output, a
prompt or an image): `journalctl -u pixelslash-opencode -f`. A shot none of whose calls worked
reads as a named `ai_error` (`opencode: timeout`, `opencode: exit`). The hosted
Cloudflare path does not use any of this.

`vite preview` sends each request to workerd on a connection of its own (`freshConnectionPerRequest`
in `vite.config.ts`, ob 1876). On the CT workerd closes its connection about 50 ms after it answers a
long finalise, and the next finalise, sent at once by the CLI, was dispatched on the socket
miniflare's undici pool had kept: `read ECONNRESET`, so a 500 `fetch failed` in the journal and a
retry from the CLI for a request that never ran. Miniflare sets `reset: false` on every request it
sends, so a `Connection: close` header cannot ask for this; the plugin sets `reset: true` on that
pool. Preview only; the Cloudflare deploy does not run it.
`deploy/ssh/serve.ts` (the LAN unit since PS-220) has no such hop: workerd listens on the port, and
a client reaches it directly, so there is no pool socket to reset and the plugin is not on its path
(it stays for `vite preview` on a development machine). A client whose keep-alive socket workerd closes right
after a long answer can still see a reset; the CLI retries a network error for 30 s (1, 2, 4, 8 and 15 s), and a
finalize is resumable. Whether the CT's workerd does that is checked by the CT run in `perf/README.md`.
