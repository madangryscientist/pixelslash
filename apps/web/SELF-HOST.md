# Self-hosting PixelSlash

Three ways to run the review app (`apps/web`) yourself:

- **In Docker**: one image and one volume, with real GitHub sign-in and no Cloudflare account. `docker
  compose up` in `docker/self-host/`; the steps are in [README.md, "Self-host in 5
  minutes"](README.md#self-host-in-5-minutes).
- **[On your own Cloudflare account](#on-your-own-cloudflare-account)**: a Worker, D1, R2 and a Queue. This is
  how the hosted app runs, and the way to get real GitHub sign-in.
- **[On your own box](#on-your-own-box)**: a Proxmox container on your network, served by Miniflare. LAN only, with
  a GitHub stand-in for sign-in. No Cloudflare account.

Both take uploads from the same CLI. Nothing here needs our account, zone or bucket: every name below is
yours to choose, and the ones in `wrangler.jsonc` are only defaults.

## What anyone who can reach it can do

Read this before you put it on the internet.

- Sign-in is GitHub's OAuth. Any GitHub account can sign in, and a signed-in user can create an org and
  projects of their own. The code has no allowlist of users. Someone who is not a member of your org cannot see
  its projects, but they can sign in and use your storage and compute for theirs. To keep it private, put it
  behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) or run it on
  your own box on a network you trust.
- `SECURITY.md` lists the hardening that is on by default (model host guard, stub refusal, rate limits).

## On your own Cloudflare account

You need a Cloudflare account with Workers, D1, R2 and Queues available on its plan (R2 asks for a payment
method before its first bucket), a GitHub account, [Bun](https://bun.sh), and `git`, `openssl` and `curl`.
Run everything from `apps/web` unless it says otherwise.

### 1. Clone, install, sign in to Cloudflare

```bash
git clone <this repo's URL> pixelslash
cd pixelslash && bun install
cd apps/web
bunx wrangler login          # or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
bunx wrangler whoami
```

### 2. Create the D1 database, the R2 bucket and the queue

```bash
bunx wrangler d1 create pixelslash
bunx wrangler r2 bucket create pixelslash-blobs
bunx wrangler queues create pixelslash-explain
```

`d1 create` prints a `database_id`. Names are per account, so the defaults are fine unless you want others;
if you change one, change it in `wrangler.jsonc` as well (`database_name`, `bucket_name`, the two `queue`
fields).

### 3. Edit `wrangler.jsonc`

Work on a branch of your own (`git switch -c mine`) and commit these edits; see "Updating".

**Do this before you build.** The build copies `wrangler.jsonc` into `dist/server/wrangler.json`, and that
copy is what `wrangler deploy` reads.

- `d1_databases[0].database_id`: the id from step 2. Only the top-level entry; the `env.e2e` one is for tests.
- `vars.IMAGE_SIGNING_SECRET`: delete this line. It is an empty placeholder, and the real value is a secret
  (step 6); a secret should be the only binding of its name.
- `ratelimits[].namespace_id`: `"2501"` and `"2502"` are ids you pick, unique within your account. Change them
  only if you already use those numbers.
- To use your own domain instead of `*.workers.dev`, add a `routes` entry, e.g.
  `"routes": [{ "pattern": "review.example.com", "custom_domain": true }]`. The domain's zone must be on your
  account.

### 4. Migrate the database

```bash
bunx wrangler d1 migrations apply DB --remote
```

Migrations are additive. Run this again after any pull that adds a file to `drizzle/`.

### 5. Create the GitHub OAuth app (sign-in)

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

| Field | Value |
| --- | --- |
| Homepage URL | your server's URL, `https://<host>` |
| Authorization callback URL | `https://<host>/auth/github/callback` |

`<host>` is your custom domain, or `pixelslash-web.<your-subdomain>.workers.dev`. You will not know the
workers.dev subdomain until the Worker exists (it is on the dashboard under Workers & Pages), so with
workers.dev do step 7 once first, then come back and edit the OAuth app's URLs; the id and secret do not
change.

Generate a client secret. Put the **client id** in `wrangler.jsonc` as `vars.GITHUB_CLIENT_ID`. The secret goes
in the next step. Leave `GITHUB_OAUTH_BASE` and `GITHUB_API_BASE` alone: a production build refuses to start
on anything but GitHub's.

### 6. Set the secrets

```bash
bunx wrangler secret put GITHUB_CLIENT_SECRET                 # paste the OAuth app's secret
openssl rand -hex 32    | bunx wrangler secret put IMAGE_SIGNING_SECRET
openssl rand -base64 32 | bunx wrangler secret put MODEL_KEY_SECRET
```

If the Worker does not exist yet, wrangler offers to create it with the secrets; say yes. Never put a secret in
`wrangler.jsonc` or git. Changing `MODEL_KEY_SECRET` later makes every stored model key unreadable (enter them
again).

### 7. Build and deploy

```bash
bun run build
bunx wrangler deploy
```

`deploy` prints the URL. Sign in at it with GitHub. To see what would be sent without sending it:
`bunx wrangler deploy --dry-run --outdir "$(mktemp -d)"`.

### 8. Create an org, a project and a token

In the app: create an org, then a project in it, then in the project's **Settings** issue a CI token
(`psci_…`). It is shown once. Save it where no repo can see it:

```bash
mkdir -p ~/.config/pixelslash
install -m 600 /dev/null ~/.config/pixelslash/token
$EDITOR ~/.config/pixelslash/token
```

### 9. Upload with the CLI

The CLI is not on npm yet, so run it from your clone. In the repo you are reviewing (it reads the commit and
branch from the directory it runs in), with a `pixelslash.config.*` there and Playwright's browser installed
(`bunx playwright install chromium-headless-shell`):

```bash
bun /path/to/pixelslash/packages/cli/src/index.ts capture --upload \
  --server https://<host> --token-path ~/.config/pixelslash/token
```

or `… upload <snapshot-dir> --server … --token-path …` for a directory you already have. `PIXELSLASH_SERVER`
and `PIXELSLASH_TOKEN` replace the two flags in CI. `docs/cli.md`, "Uploading to a server", has the rest. A build
on the project's default branch (`main`) is accepted as the baseline; a build on any other branch is diffed
against it and waits for review.

### 10. Optional: GitHub check runs

A second, separate GitHub **App** (not the OAuth app) posts a `PixelSlash` check run on each build's commit.
It is outbound only. Skip it if you do not want it.

```bash
URL=https://<host>
tmp=$(mktemp -d)
jq --arg url "$URL" --arg name "PixelSlash $USER" '.url = $url | .name = $name' \
  github-app/manifest.json > "$tmp/manifest.json"
python3 - "$tmp/manifest.json" <<'PY' > "$tmp/register-app.html"
import html, json, sys
manifest = json.dumps(json.load(open(sys.argv[1])))
print('<form action="https://github.com/settings/apps/new" method="post">'
      f'<input type="hidden" name="manifest" value="{html.escape(manifest)}">'
      '<button>Create the App</button></form>')
PY
```

`url` (it points at our repository in the file) and `name` (it must be unique on GitHub) are the two fields
replaced. Open `$tmp/register-app.html` and press the button. GitHub then redirects to
`http://localhost:8787/?code=…`, which does not load; copy the `code` (good once, for an hour). Trade it, and
send the key straight to Cloudflare:

```bash
reply=$(curl -fsS -X POST -H 'accept: application/vnd.github+json' \
  "https://api.github.com/app-manifests/$code/conversions")
jq -r .pem <<<"$reply" | bunx wrangler secret put GITHUB_APP_PRIVATE_KEY
jq -r .id  <<<"$reply"           # the App id
unset reply
```

Set `vars.GITHUB_APP_ID` to that id and `vars.PIXELSLASH_PUBLIC_URL` to `$URL` in `wrangler.jsonc`, build and
deploy again, install the App on the repos you review, and set each project's **GitHub repo** in its
settings. `github-app/README.md` has the details.

### Variables

Set in `wrangler.jsonc` under `vars` (public) or with `wrangler secret put` (secret). The column says which
are needed.

| Name | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | var | **yes** | The OAuth app's client id. Empty, nobody can sign in. |
| `GITHUB_CLIENT_SECRET` | secret | **yes** | The OAuth app's client secret. |
| `IMAGE_SIGNING_SECRET` | secret | **yes** | Signs the short-lived image URLs. Unset, image URLs fail. |
| `MODEL_KEY_SECRET` | secret | for AI notes | Base64 of 32 random bytes. Seals each project's model API key. Unset, a model key cannot be saved and builds are reviewed as plain pixels. Set it anyway. |
| `GITHUB_OAUTH_BASE`, `GITHUB_API_BASE` | var | no | Leave as shipped (`https://github.com`, `https://api.github.com`). Anything else stops a production build. |
| `DEFAULT_DIFF_LOCATION` | var | no | Where a new project diffs. Shipped as `ci` (the CLI measures in the job). Anything else is `server`. |
| `MIN_CLI_VERSION` | var | no | The oldest CLI the API takes (`x.y.z`). Empty takes any. |
| `GITHUB_APP_ID` | var | no | Check runs: the App's id. With the key, below. |
| `GITHUB_APP_PRIVATE_KEY` | secret | no | Check runs: the App's PEM. Both App values must be set or nothing calls GitHub. |
| `GITHUB_STATUS_TOKEN` | secret | no | Without the App: a fine-grained token (commit statuses: write) posts the build verdict as a `PixelSlash` commit status. Ignored when the App is set. See `README.md`. |
| `PIXELSLASH_PUBLIC_URL` | var | no | Your server's URL, no trailing slash. A check run's "Details" link. |
| `SENTRY_DSN` | secret | no | Error reporting; off while empty. |
| `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT` | var | no | Labels on those reports. |
| `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS` | var | no | `1` lets a project's model sit on a private network. Never on a deployment strangers sign in to. |
| `DIFF_SIDECAR_URL` | var | no | A loopback diff process. Not used on Cloudflare; leave unset. |

Bindings (`DB`, `BLOBS`, `EXPLAIN`, `API_RATE_LIMIT`, `SIGNIN_RATE_LIMIT`) come from `wrangler.jsonc`, not from
`vars`.

### Updating

Keep your step 3 edits (and the ones in step 10) as a commit on your own branch, so an upstream change to
`wrangler.jsonc` rebases instead of conflicting. Then `git pull --rebase && bun install`, apply any new
migration (step 4), `bun run build && bunx wrangler deploy`.

## On your own box

The deploy this repo uses for its own LAN server, with our addresses taken out. A Proxmox host runs a
container, a script on your machine builds a release and pushes it in, and the container switches to it and
rolls back if the new one does not come up. D1 and R2 are Miniflare's, on the container's disk. No Cloudflare
account.

**It is LAN only.** Sign-in is the GitHub stand-in (`e2e/github-stub.ts`): everyone who can reach the address
signs in as `e2e-octocat` and sees every org. No port forward, no tunnel, no public DNS. For real sign-in, use
the Cloudflare section above.

### One-time setup of the container

`release.sh` and `update.sh` assume this layout; change it and the scripts' paths together.

1. A Debian-family container with systemd and a **static address**, reachable from your machine by ssh through
   the Proxmox host as root. The reference one is 2 vCPU, 2 GB, 10 GB.
2. A user `pixelslash` with home `/home/pixelslash`, [Bun](https://bun.sh) installed for it
   (`/home/pixelslash/.bun/bin/bun`), and Node 24 in `/usr/local` (wrangler runs under it).
3. The deployment's secrets, in a mode 600 file owned by `pixelslash` at
   `/home/pixelslash/pixelslash/apps/web/.dev.vars.e2e` (create the directory; `update.sh` fails without the
   file). `<box>` is the container's address:

   ```
   GITHUB_OAUTH_BASE=http://<box>:4174
   IMAGE_SIGNING_SECRET=<openssl rand -hex 32>
   MODEL_KEY_SECRET=<openssl rand -base64 32>
   ```

   `GITHUB_OAUTH_BASE` has to be the address your browser can reach, because the browser is sent to the
   stand-in there to sign in.

### Deploy

On your machine, from a clean checkout of the commit to ship (the script refuses a dirty tree or a sha that is
not `HEAD`):

```bash
PIXELSLASH_LAN_SSH=root@<proxmox host> PIXELSLASH_LAN_CT=<container id> \
  PIXELSLASH_LAN_SSH_KEY=~/.ssh/<key> \
  apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"
```

`PIXELSLASH_LAN_SSH_KEY` is optional. The script builds here with `CLOUDFLARE_ENV=e2e bun run build`, sends the
commit's files and the build over ssh, and runs that release's `update.sh` in the container, which installs it
beside the one serving, applies the migrations, switches, and goes back by itself if `:3000` does not answer.
It stops while a build is being diffed (`PIXELSLASH_DEPLOY_FORCE=1` overrides). The dashboard is then at
`http://<box>:3000`. Releases are kept under `/home/pixelslash/releases` (the last three); logs are
`journalctl -u pixelslash-web -f`.

Then do steps 8 and 9 above with `--server http://<box>:3000`. A token works only on the server that issued it.

`release.sh` uses `pct push` and `pct exec`, so it needs a Proxmox host. On any other machine, do by hand what
the `remote` block in the script does: build, pack the tarball the way the script does, copy it over, and run
`apps/web/deploy/ssh/update.sh <sha>.tar.gz` as root there (the file must be named `<sha>.tar.gz`, or
`pixelslash-<sha>.tar.gz`).

### More

`release.sh` can also carry a Sentry DSN, the GitHub App (`PIXELSLASH_GITHUB_APP_ID`,
`PIXELSLASH_GITHUB_APP_KEY`, `PIXELSLASH_PUBLIC_URL`) and, on the container, an AI explain helper. The diff
sidecar is always installed. These, the memory caps and the rest are in `README.md`, "Run it on the Proxmox
server".
