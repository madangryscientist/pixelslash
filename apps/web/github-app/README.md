# The PixelSlash GitHub App (PS-23)

The App is named **PixelSlash Review** (slug `pixelslash-review`, id `5528217` in production). The name
"PixelSlash" is reserved on GitHub, so the manifest's `name` field carries "PixelSlash Review" too; a
manifest that says "PixelSlash" will not register.

The App posts a commit status, named **PixelSlash**, on each build's commit in the repo a project is
connected to (project settings → GitHub repo). Its **Details** link opens the build page in one
click (a check run's opens GitHub's own check page, which is why it is not one):

| Build | Commit status |
| --- | --- |
| uploading, processing | `pending` |
| changes to review | `pending`, titled with what waits ("3 changes to review") |
| a rejected shot | `failure` |
| every change accepted, or nothing changed | `success` |
| errored | `failure`, titled with the error |

The description is that one-line title and `target_url` is the build page on
`PIXELSLASH_PUBLIC_URL`; the counts and the waiting shots are in the PR comment and on the build
page. A new status is posted on finalize, on every accept or reject, on accept-all, on rerun, on
marking a shot flaky and when the model passes a build, and GitHub shows the newest. A build that
ends `changes` (a changed or new shot waits for review) keeps it pending, so a status that branch
protection requires blocks the merge until the review is done; removed shots never do (PS-284). No
image goes to GitHub, only the link.

**An App registered when it posted check runs** needs one more permission: the owner grants
**Commit statuses: Read and write** in the App's settings (Permissions & events), and each
installation's owner accepts the upgrade request GitHub sends. Until then the status calls fail
with a 403, which is logged and not reported. A branch protection rule that requires `PixelSlash`
keeps working by name; if it was tied to the App's check run, pick `PixelSlash` from the list
again. A build that still has a check run from before gets it completed once, as `neutral` and
titled "Moved to the PixelSlash commit status", on its next sync; `checks: write` stays for that.

### The pull request comment (PS-82)

A build made for a pull request (`prNumber`, which the CLI sends from the CI's PR) also keeps **one
comment** on that PR, created by the first build and edited in place by every later one, so a PR
never collects a comment per push. It carries the project model's summary of the build (or "Summary
skipped" when the project has no model, or the model's call failed), the counts table, the three to
five most changed shots as links to their page, and the link to the build page. Only the newest
build of a PR edits its comment. A comment someone deleted is made again on the next sync. The
comment is text and links: no image is sent. A project turns it off in settings → GitHub repo →
"Comment on pull requests"; the commit status stays. The comment is posted to the project's connected repo
and nowhere else, and a failed comment call is logged like a failed status: it never changes a
build's verdict and it never stops the status being sent.

The comment needs `pull_requests: write`. An installation made before PS-82 granted only `read`:
**the owner of the App changes the permission in the App's settings, and the installation's owner
accepts the upgrade request GitHub sends**, or the comment calls fail with a 403 (logged; the commit
status is unaffected).

The App is outbound only: it has **no webhook**, and its permissions are `statuses: write`,
`pull_requests: write`, `metadata: read` and `checks: write`, the last only to complete a check run
left from before (`manifest.json`). It is not public. With no App
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
| `PIXELSLASH_PUBLIC_URL` | `wrangler.jsonc` vars / `.dev.vars` / the CT's `.dev.vars.e2e` | The server's URL as a reviewer opens it; the commit status links the build page on it. Unset, the status has no link. |

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
