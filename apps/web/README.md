# apps/web — the PixelSlash review app

TanStack Start on Cloudflare Workers, D1 via Drizzle, R2 for the shots, GitHub sign-in. CI uploads
builds with `pixelslash upload`; people review them here.

## Secrets

A deployment sets these with `wrangler secret put <NAME>` (or in `.dev.vars` locally; the names are
in `.dev.vars.example`). Never in git.

| Secret | What it is |
| --- | --- |
| `GITHUB_CLIENT_SECRET` | The GitHub OAuth app's secret, for sign-in. |
| `IMAGE_SIGNING_SECRET` | Signs the short-lived image URLs. |
| `MODEL_KEY_SECRET` | Base64 of 32 random bytes (`openssl rand -base64 32`). Seals each project's model API key at rest with AES-256-GCM (stored as `v1:<iv>:<ciphertext>`). Unset, saving a model key fails with "MODEL_KEY_SECRET is not set" and a stored key is not read, so builds are reviewed as plain pixels. A key saved before this existed is plain text until the project's model settings are next saved. Changing the secret makes the keys sealed under the old one unreadable: enter each key again. |

The `e2e` env in `wrangler.jsonc` carries fixed test values for these; they are not secrets.

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
then `bunx vite preview --host 127.0.0.1 --port 3000 --strictPort`.

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

## Run it on the Proxmox server

The same local server, on the Proxmox host instead of the desktop, so the dashboard is up without
anything running here. It is **LAN only**: sign-in is still the GitHub stand-in, so anyone who can
reach the address signs in as `e2e-octocat` and sees every org. No port forward, no tunnel, no
public DNS. Real GitHub sign-in is a later ticket.

| | |
| --- | --- |
| Dashboard | `http://192.168.0.34:3000` |
| Stand-in | `http://192.168.0.34:4174` (the browser is sent there to sign in) |
| Container | CT 135 `pixelslash` on `192.168.0.20`: Debian 13, unprivileged, 2 vCPU, 2 GB, 10 GB on `local-lvm`, starts on boot. The address is static in the CT config, below the router's DHCP pool. |
| Checkout | `/home/pixelslash/pixelslash`, user `pixelslash`, `origin/main` over a read-only deploy key ("pixelslash CT 135"); the push URL is `no-push-from-this-ct`. Bun is in `~pixelslash/.bun`, Node 24 (for wrangler) in `/usr/local`. |
| State | D1 and R2 in `apps/web/.wrangler/state` on the CT's disk, kept across restarts and updates. |
| Units | `pixelslash-stub` (`bun e2e/github-stub.ts`) and `pixelslash-web` (`vite preview` of the production build), from `deploy/lan/`. Both restart on failure and start on boot. |

The build is the `e2e` environment's with three values replaced. `apps/web/.dev.vars.e2e` on the CT
(mode 600, gitignored, never in git) sets `GITHUB_OAUTH_BASE=http://192.168.0.34:4174`, so the
browser on another machine is sent to the stand-in at the CT's address rather than its own
`localhost`, a random `IMAGE_SIGNING_SECRET`, and the deployment's `MODEL_KEY_SECRET` (without it
the CT would seal keys under the `e2e` env's fixed test value). The Cloudflare plugin copies it into
`dist/server/.dev.vars` at build time and `vite preview` reads it from there; the `e2e` env in
`wrangler.jsonc`, and so the tests, are unchanged.

Update to `origin/main` (pull, stop, install, migrate, build, restart) from the desktop. It is not
run automatically. **A deploy has a short downtime:** `pixelslash-web` is stopped before the install
and build, because the running workerd holds most of the CT's 2 GiB and a build beside it thrashes
the CT for tens of minutes; with it stopped the whole update takes about 12 s and :3000 is down for
that long. The stub stays up. If a step fails after the stop, the previous build is put back and the
server is started on it, and the script exits 1.

```bash
ssh -i ~/.ssh/id_ed25519_mac root@192.168.0.20 \
  pct exec 135 -- /home/pixelslash/pixelslash/apps/web/deploy/lan/update.sh
```

Logs: `pct exec 135 -- journalctl -u pixelslash-web -f`. Point a project's upload at it with
`PIXELSLASH_SERVER=http://192.168.0.34:3000` and a token issued in its Settings on the CT. A token
works only on the server that issued it: `~/.config/pixelslash/hackcove-local.token` now holds the
CT's hackcove token, which replaced the desktop server's, so a desktop server started again needs a
token of its own in another file.

The diff runs inline in the finalise request with a 25 s budget (`DIFF_BUDGET_MS`), which stands in
for a Worker's CPU limit. On the CT's 2 vCPU a build of hackcove's 145 shots measures about 126 and
then stops at the budget: the build reads `errored` and names how many shots are left. A finalise
sent again resumes (it keeps what was measured and diffs the rest), and `pixelslash upload` sends it
again by itself while the count falls, so the build ends with all 145 measured and its real verdict.

`vite preview` sends each request to workerd on a connection of its own (`freshConnectionPerRequest`
in `vite.config.ts`, ob 1876). On the CT workerd closes its connection about 50 ms after it answers a
long finalise, and the next finalise, sent at once by the CLI, was dispatched on the socket
miniflare's undici pool had kept: `read ECONNRESET`, so a 500 `fetch failed` in the journal and a
retry from the CLI for a request that never ran. Miniflare sets `reset: false` on every request it
sends, so a `Connection: close` header cannot ask for this; the plugin sets `reset: true` on that
pool. Preview only; the Cloudflare deploy does not run it.
