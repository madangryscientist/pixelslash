# The PixelSlash GitHub App (PS-23)

The App posts one check run, named **PixelSlash**, on each build's commit in the repo a project is
connected to (project settings → GitHub repo):

| Build | Check run |
| --- | --- |
| uploading, processing | `in_progress` |
| changes to review, or a rejected shot | `failure` |
| every change accepted, or nothing changed | `success` |
| errored | `failure`, titled with the error |

The summary is the counts and `details_url` is the build page on `PIXELSLASH_PUBLIC_URL`. It is
updated in place on finalize, on every accept or reject, on accept-all, on rerun, on marking a shot
flaky and when the model passes a build. New and removed shots never fail it. No image goes to
GitHub, only the link.

The App is outbound only: it has **no webhook**, and its permissions are `checks: write`,
`metadata: read` and `pull_requests: read` (`manifest.json`). It is not public. With no App
configured, or a project with no repo, the server calls GitHub not at all. A failed GitHub call is
logged and reported to Sentry; it never changes a build's verdict and never fails a review.

## Register it (one time)

GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
creates the App from `manifest.json`. Its `redirect_url` is `http://localhost:8787/`: nothing needs
to listen there, GitHub only puts a one-time `code` in that URL.

1. Make a local page that posts the manifest (to an org, use
   `https://github.com/organizations/<org>/settings/apps/new` as the action):

   ```bash
   cd apps/web/github-app
   python3 - <<'PY' > "$TMPDIR/register-app.html"
   import html, json
   manifest = json.dumps(json.load(open("manifest.json")))
   print(f'<form action="https://github.com/settings/apps/new" method="post">'
         f'<input type="hidden" name="manifest" value="{html.escape(manifest)}">'
         f'<button>Create the PixelSlash App</button></form>')
   PY
   ```

2. Open `$TMPDIR/register-app.html`, press the button, check the name (it must be unique on GitHub;
   rename it if taken) and create the App. The browser lands on `http://localhost:8787/?code=…`,
   which does not load. Copy the `code`; it works once and for an hour.
3. Trade the code for the App's id and private key. The key goes straight into a file or your secret store, never onto the
   screen, and only the id is printed:

   ```bash
   code=<the code>
   reply=$(curl -fsS -X POST -H 'accept: application/vnd.github+json' \
     "https://api.github.com/app-manifests/$code/conversions")
   (umask 077; jq -r .pem <<<"$reply" > github-app-key.pem)   # or pipe it into your secret store; never in git
   jq -r .id <<<"$reply"        # the App id
   unset reply
   ```

   (Or create the App by hand under Settings → Developer settings → GitHub Apps with the same
   permissions, no webhook, "Only on this account", then generate a private key there.)

4. In the App's settings, check that **Webhook → Active** is off.
5. Install the App (its public page → Install) on the repos whose projects will be connected.
6. Connect each project: project settings → **GitHub repo** → `owner/name`.

## Configure the server

| Var | Where | Meaning |
| --- | --- | --- |
| `GITHUB_APP_ID` | `wrangler.jsonc` vars / `.dev.vars` / the CT's `.dev.vars.e2e` | The App id. |
| `GITHUB_APP_PRIVATE_KEY` | `wrangler secret put` / `.dev.vars` / the CT's `.dev.vars.e2e` | The App's private key: the PEM as GitHub gave it, the PEM with `\n` for its newlines, or its base64 on one line. |
| `PIXELSLASH_PUBLIC_URL` | `wrangler.jsonc` vars / `.dev.vars` / the CT's `.dev.vars.e2e` | The server's URL as a reviewer opens it; the check run links the build page on it. Unset, the check run has no link. |

Both App vars must be set, or nothing calls GitHub. Installation tokens are minted per repo and
cached until five minutes before GitHub expires them.

**The LAN self-host.** `release.sh` carries all three, the way it carries the Sentry DSN: each goes
into the release tarball as a mode-600 file (never on a command line, never printed), and
`update.sh` saves it in the CT's `.dev.vars.e2e`, where every later release finds it. The key is
base64'd onto one line for the trip. A var left unset keeps what the CT has.

```bash
PIXELSLASH_GITHUB_APP_ID=<the App id> \
PIXELSLASH_GITHUB_APP_KEY="$(cat github-app-key.pem)" \
PIXELSLASH_PUBLIC_URL=http://<the CT's address>:3000 \
PIXELSLASH_LAN_SSH=root@$SSH_HOST PIXELSLASH_LAN_CT=$CT PIXELSLASH_LAN_SSH_KEY=~/.ssh/<key> \
  apps/web/deploy/ssh/release.sh "$(git rev-parse HEAD)"
```

**Cloudflare.** `wrangler secret put GITHUB_APP_PRIVATE_KEY` (paste the PEM), and set
`GITHUB_APP_ID` and `PIXELSLASH_PUBLIC_URL` in `wrangler.jsonc`'s vars.
