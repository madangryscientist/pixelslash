# Security

> **Draft.** This file is owned by the open-source ticket T8 (public README and community files), which writes the reporting channel, the scope and the
> response target. Until then it holds only the sections the hardening ticket (T5, PS-250) needed
> written down.

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
