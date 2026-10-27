# Security

## Reporting a vulnerability

Report it privately, not in a public issue: use GitHub's private vulnerability reporting, **Security
> Report a vulnerability** on [the repository](https://github.com/madangryscientist/pixelslash/security/advisories/new).
If you cannot use GitHub, email hello@hack-cove.com. Only the maintainers can read the report. Say what you found, the version or commit, and the steps
to reproduce it; a proof of concept helps.

This is a one-maintainer project, so these are targets, not guarantees: an acknowledgement within
5 working days, and a fix or a plan within 30 days for anything that is in scope. We will credit
you in the advisory unless you ask us not to. Please give us that time before you disclose, and do
not test against someone else's deployment or data.

## What is in scope

- **The CLI** (`packages/cli`, the `pixelslash` npm package) and **the engine** it runs
  (`packages/engine`): for example, a screenshot or a token leaving the machine without
  `--upload`, a token written to a file or a log, or a crafted PNG or config that runs code.
- **The review app** (`apps/web`) and **the upload API** (`/api/v1`): authentication and
  authorisation (reaching another org's builds, shots or tokens), token handling, the signed image
  URLs, request forgery, injection, and anything that lets one member spend another's resources.
- **The capture image** (`docker/capture`) as we build it.

Out of scope: a deployment you configured weakly (read "What anyone who can reach it can do" in
[`apps/web/SELF-HOST.md`](apps/web/SELF-HOST.md)), a vulnerability in a dependency that does not
affect PixelSlash (report it upstream), findings that need a stolen token or a machine you already
control, rate-limit tuning, and the e2e GitHub stand-in, which is for tests and refused in a
production build.

## The threat model, short

The code is public, so assume an attacker has read it. Nothing here depends on the code being
secret: every secret is read from the environment, never from the tree.

- **Shots stay local unless you upload.** Without `--upload` no page shot leaves the machine. With
  it, shots go only to the server the project names. The one other place pixels can go is a
  project's own AI model, opt-in per project: the server sends that endpoint the three crops of a
  changed region, never a whole shot. We accept reports against either rule.
- **Sign-in** is GitHub OAuth. Any GitHub account can sign in; what a user can see is decided by
  org membership, which is by invite. The session is the `HttpOnly` `pss_` cookie.
- **Tokens** (the prefixes below) are stored only as SHA-256 hashes, can be revoked, and are
  prefixed so GitHub's secret scanning and the Sentry scrubber can spot them.
- **Model keys** are sealed with AES-GCM under `MODEL_KEY_SECRET` before they are stored. **Image
  URLs** are signed with `IMAGE_SIGNING_SECRET` and short-lived.
- **The model endpoint is attacker-controlled input.** A project owner names the base URL the
  server calls, so the server refuses private and local targets (below).
- **The GitHub App** only writes check runs: its manifest subscribes to no webhooks, and each
  deployment registers its own App.
- **Errors, never shots, go to Sentry**, and only when a DSN is set. Every report passes
  `scrubEvent` (`packages/engine/src/sentry-scrub.ts`), which drops request bodies, cookies, query
  strings, auth headers, tokens and image data.

## Token prefixes

Every credential the server issues starts with a fixed prefix, so the Sentry scrubber
(`packages/engine/src/sentry-scrub.ts`), GitHub's secret scanning and a reader of a log can tell
what leaked. The server stores only a SHA-256 hash of each token, never the token.

| Prefix | What it is | Issued by | Reaches |
| --- | --- | --- | --- |
| `psci_` | a CI upload token | a project's settings | that one project |
| `psorg_` | an org token | an org's settings | every project of that org, as its CI |
| `psu_` | a personal token | the user's settings | every project of the user's orgs, as that user |
| `pss_` | a sign-in session | GitHub sign-in, in the `HttpOnly` session cookie | the web app, as that user |

A leaked `psci_`, `psorg_` or `psu_` token is revoked from the page that issued it; a session ends
at sign-out. All four are 32 random bytes after the prefix.

## What a deployment must set

- `IMAGE_SIGNING_SECRET`, `MODEL_KEY_SECRET` and the GitHub OAuth app (`GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`); see `apps/web/README.md`, "Secrets".
- Nothing else is needed to stay safe; the hardening below is on by default.

## Hardening a stranger's deployment gets by default (PS-250)

- **A project's model is on the public internet.** A model base URL on loopback, an RFC 1918
  range, link-local (169.254/16, the cloud metadata address), CGNAT (100.64/10), the IPv6 forms
  of those, a `.local`/`.internal` or single-label name, or a scheme other than http(s) is refused
  when it is saved and again before every call, after the name is resolved; a redirect is not
  followed. A self-host that runs its own model on its own network sets
  `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS=1`; the scheme check holds either way. Known limit: the
  check resolves the name and the request resolves it again, and a Worker's `fetch` cannot pin the
  address it checked, so a name whose DNS answer changes between the two (DNS rebinding) is not
  caught. On Cloudflare the request leaves from Cloudflare's network, not the deployment's.
- **The GitHub sign-in stand-in is for tests.** A production build whose `GITHUB_OAUTH_BASE` or
  `GITHUB_API_BASE` is not GitHub's does not start, and says why. Only `vite dev` and the
  `CLOUDFLARE_ENV=e2e` build may point at the stand-in, which lets anyone sign in as anyone.
- **Rate limits.** On Cloudflare, `/api/v1/*` is limited per token (per client IP for a refused
  token) and sign-in per client IP, with the `ratelimits` bindings in `apps/web/wrangler.jsonc`;
  over the limit is a 429. A deployment without the bindings (the self-host) is not limited.
