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
| Units | `pixelslash-stub` (`bun e2e/github-stub.ts`) and `pixelslash-web` (`vite preview` of the production build), from `deploy/lan/`. `pixelslash-diff` (`bun deploy/lan/diff-sidecar.ts`, the diff sidecar below) runs beside them. All three restart on failure and start on boot. With the opencode switch on (below) a fourth, `pixelslash-opencode`, runs the same way. |

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

**workerd's memory (PS-155).** A day of `/workerd-rss.log` samples (every 10 min, 2026-10-23 to 25) shows workerd at 127-140 MB idle
and stepping to 1.5-1.8 GB (peak 1.82 GB) within one 10-minute sample of an upload burst (the snapshot PUTs and `finalize`),
then holding there for hours until the unit restarts, which brings it back to 130 MB. It does not grow without bound, but it
does not give the memory back, and with `vite preview` (~0.5 GB) beside it the peak is more than the CT's 2 GiB: that was the
two OOM kills of 2026-10-25. `pixelslash-web.service` therefore carries `MemoryHigh=1400M`, `MemoryMax=1700M` and
`OOMPolicy=stop`; `update.sh` installs the unit, so the cap survives an update.

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

### The diff sidecar

workerd cannot load a native addon, so in-process the server diff runs its hot loops in WebAssembly
(`DIFF_WASM`, on by default since PS-207; any other value is pngjs, the slow part of a diff, see
`bench/PERF.md`). On the self-host the Worker instead sends each
shot's two PNGs to a Bun process on the same box: `deploy/lan/diff-sidecar.ts`, unit
`pixelslash-diff`, on `127.0.0.1:4181`. It runs the engine's own `diffPngs` with the same options and
ignore areas, with the CLI's napi-image codec (PS-185), and answers with the result and the overlay.
The verdict, the counts and the regions are the same as in-process, and the overlay's pixels are the
same; only its PNG bytes differ, as two encoders deflate the same pixels differently
(`src/diff/sidecar.test.ts` holds this on every `bench/corpus` pair and the e2e fixtures).

`DIFF_SIDECAR_URL` names it, in `wrangler.jsonc`'s `env.e2e` vars only, so the CT build and the
production e2e run use it (that run starts a sidecar of its own on a free port;
`PIXELSLASH_E2E_NO_SIDECAR=1` runs it without one). `test:e2e:dev` starts none, so the in-process diff
stays under an e2e run. The Cloudflare deploy never sets it and never bundles the addon. Only a
loopback URL (`127.0.0.1`, `localhost`, `[::1]`) is used; any other is refused, so a typo cannot send
shots off the box. When it is unset, refused, down, times out (15 s) or answers with an error, the
shot is measured in-process (WebAssembly, or pngjs when `DIFF_WASM` is not `1`), and the reason is
logged once per kind, not once per shot.
After the first shot it cannot reach, the rest of that build skips it, so a hung sidecar costs one
timeout, not one per shot. A PNG the sidecar cannot decode is measured in-process too, without a log
line, so pngjs reports it in its own words as on Cloudflare.

```
server diff: in-process pngjs (unreachable): http://127.0.0.1:4181/v1/diff: Unable to connect...
```

The shots go over loopback to a process bound to 127.0.0.1 and nowhere else; nothing is written to
disk (invariant 4). `update.sh` installs and restarts the unit before `pixelslash-web` starts, and a
sidecar that does not come up is a warning, not a rollback: the Worker measures in-process. The unit
is capped at `MemoryHigh=450M` / `MemoryMax=600M` (it idles at ~40 MB and peaked at ~340 MB on
PS-200's burst); `pixelslash-web`'s cap is unchanged. Logs, one line per diff with its time:
`journalctl -u pixelslash-diff -f`.

### The AI explain step through opencode

The explain step needs a model, and workerd cannot start a process, so on the CT it reaches the
`opencode` CLI through a helper on the same box: `deploy/lan/opencode-helper.ts`, unit
`pixelslash-opencode`. It serves one route, `POST /v1/chat/completions` on `127.0.0.1:4180`, in the
shape `complete()` in `src/ai/model.ts` already sends, and answers each call with the engine's
tool-less `opencode run` (no `--auto`, a deny-everything agent, no server). A region's three crops
and the build summary's text-only call both go through it. The images are written to a private temp
dir that is removed when the call ends. It is **off** until you turn it on, and it is for this
personal self-host only: the OpenCode Go plan it uses is for personal use.

```bash
# On the CT, as root: the model (provider/model), then the key, then an update.
echo opencode-go/claude-haiku-5-5 > /etc/pixelslash/opencode-helper
install -d -o pixelslash -g pixelslash /home/pixelslash/.config/pixelslash
install -m 600 -o pixelslash -g pixelslash /dev/stdin /home/pixelslash/.config/pixelslash/opencode.key
/home/pixelslash/pixelslash/apps/web/deploy/lan/update.sh
```

While `/etc/pixelslash/opencode-helper` exists, `update.sh` checks it and the key file (which must
be mode 600), installs the opencode release the capture image pins, enables the unit, and gives
every non-smoke org without a model a row pointing at `http://127.0.0.1:4180/v1` with a placeholder
key. The real key is only in the token file; the helper puts it in opencode's environment, so it is
never in git, the unit, a log line or a reply. An org or project with a model of its own keeps it
and wins. The rows are written when `update.sh` runs, so an org created afterwards has no explain
step until the next update. Remove the file and run `update.sh` again to turn it off: the rows that
point at the helper are deleted and the unit is stopped and removed. With the file never made,
`update.sh` does nothing about the helper.

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
