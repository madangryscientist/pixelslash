---
label: wayfinder:map
title: PixelSlash — open, no-lock-in Chromatic replacement
---

## Destination

**PixelSlash** (placeholder name; claim check is ob 1461) — a cheaper Chromatic replacement with no vendor lock-in, not tied to Storybook. Builds, Argos-style baselines, accept/reject and a GitHub check, over full-page shots captured in a pinned environment. Open source at launch (AGPL server, MIT CLI). Run it on our hosting or on your own Cloudflare; bring your own AI model to cut cost. **Web first**; mobile, desktop and generic PNG ingest later.

**Launch path:** private beta (invite-only hosted, free, GitHub only, Docker-in-CI capture) → public launch (self-serve signup, billing, docs, self-host guide, public repo).

**Lead against Argos** (the real rival: MIT, $100/35k, same baseline model): supported self-host + deterministic capture image + an AI that explains the diff's regions and judges against a design system, with BYO model. Price supports the pitch; it is not the headline.

## Notes

- Parent ticket: [Visual Compare: Figma + live site + new version, plus AI/tracker confidence](ob://649). Grilled 2026-09-13; re-grilled 2026-10-19 for the Chromatic-replacement pivot, readback confirmed.
- Domain: this repo (extracted from omnibus 2026-10-19, ob 1418). Dashboard: its own review app (ob 1421); the omnibus /pixelslash pages are retired by ob 1419.
- Seed DS: `@omnibus/ui` + Catppuccin Mocha (`platform/ui`). hack-cove already consumes it. After [HITL: create the Figma DS file from @omnibus/ui](ob://651), **Figma is the spec**.
- `ob vision compare` (ob 468) stays a two-screenshot layout tool. This product does not reuse that CLI as the product; it may reuse the local mlx spawn pattern.
- `apps/visual-gate` was the leftover Chromatic app. Removed (ob 915). PixelSlash is the capture-and-judge engine.

## Decisions (grilled 2026-10-19, readback confirmed)

Closed decision tickets: review model (1422), capture (1423), diff + flake (1424), hosting/tenancy/auth (1425), positioning + pricing (1426). Research: `docs/research/competitor-pricing.md`.

- **Review model.** A build is one upload for one project at one commit. A snapshot is a name + a fixed variant (platform, browser, viewport, theme) + tags. Baseline is Argos-style: the CLI uploads the merge-base and ~20 ancestor SHAs; the server picks the newest accepted build among them; acceptances carry forward within a branch. Builds on `main` are auto-accepted (handles squash and rebase). Changed snapshots block; new and removed don't. Any project member accepts or rejects per snapshot or per build; a rejection fails the check until a new build. GitHub only: a GitHub App check on hosted, a token commit status on self-host.
- **CLI.** Stays a free local tool (pair mode, `report.html`, exit codes) and gains `upload` / `--upload`. Nothing leaves the machine without it.
- **Capture.** Three configurable modes, built in this order: (1) a pinned Docker image (fixed browser + fonts) in the customer's CI, (2) our cloud browsers loading a URL, (3) DOM upload. Bare-machine capture works but is never the default and the docs discourage it — dev machines have stray fonts that skew results. Every snapshot carries an environment fingerprint (image digest, browser version, font-set hash); only matching fingerprints are compared, and a fingerprint change means re-baseline, not 400 false diffs. Defaults: animations off, caret hidden, frozen clock, frozen page timers, settled page, DPR 1. Masks are CSS selectors or rectangles. The image may start the app from a configured command.
- **Diff.** Full PNGs are always uploaded; the server diffs. Pixelmatch-style with anti-aliasing detection and an optional per-snapshot tolerance; no SSIM; no PNG-hash dedupe (one pixel breaks it). Correctness before cost; later cost cutting hashes source inputs, Nx-cache style.
- **AI.** The pixel diff finds the change; the AI only explains it, one changed region at a time ("what changed here, and does it look intentional?"). Three jobs: noise filter (label-only by default, auto-pass if a project opts in), region-anchored explanation, and the design-system judge reading a design-token file (reports only unless "new violations fail" is on). Any OpenAI-compatible vision endpoint (BYO). Free hosted tiers are BYO; paid tiers include ours.
- **Hosting + data.** One codebase. Hosted and self-host on your own Cloudflare first; Docker self-host after launch, so DB and storage sit behind interfaces from day one. Org → projects → builds. GitHub OAuth on hosted, per-project CI tokens; self-host is single-org with GitHub OAuth or email/password. Live baselines kept for the project's lifetime; PR builds and diffs 30 days. Per-org encrypted storage, signed URLs only; our model never trains on customer shots.
- **Pricing shape.** Bill only changed shots (a non-zero diff kept for review); unchanged and failed captures are free. Over the included amount we rate-limit (queue/throttle) rather than bill overage. Every limit is published. Price points wait for beta cost data (ob 1475).
- **Review UI.** Side-by-side, diff overlay and slider; j/k/a/r keys; build page grouped changed / new / removed / AI-filtered. Lives in `apps/web`.
- **Repo.** A small Nx monorepo: `packages/engine`, `packages/cli`, `apps/web`, the capture image. Fully open source at first; anything closed later goes in a separate repo, if ever. Standard stack (omnibus 1427).

## Earlier decisions (superseded 2026-10-19)

Grilled 2026-09-13 as decision #55, amended by #58 and #62. Superseded by the pivot: "not a Chromatic land gate", "v1 = local CLI, SaaS last", "page shots never leave the machine", "Chromatic cloud / uploading shots out of scope". Still in force: Figma dogfood is out of scope (#62); the local pair mode's contract in README.md.

## Not yet specified

- Self-host guide + single-org email/password auth (public-launch gate). Docker self-host (after launch).
- Cloud-browser capture and DOM upload (capture modes 2 and 3).
- Design-system judge on a design-token file; "new violations fail".
- Billing, self-serve signup, docs site (public-launch gate, after price points).
- Re-shoot on transient UI state instead of failing (ob 1460).
- Source-input hashing to skip unchanged captures (cost cutting).
- Mobile, desktop, generic PNG ingest. GitLab/Bitbucket.

## Out of scope

- Cue app / cue-designs / Linear ingest. Decision #54.
- Replacing `ob vision compare`.
- Auto-landing on a score. Rewriting `@omnibus/ui` from Figma.
- Figma dogfood: drawing specs, driving Figma, grim-vs-Figma zero, and the Figma column on Omnishell or the dashboard (770, 771, 772, 781, 782, 773, 783). Closed 2026-09-22. Decision #62.
- Billing overage charges (we rate-limit instead).

## Frontier (ob)

Build order (each blocks the next unless noted):

1. [PixelSlash: Nx monorepo on the standard toolchain](ob://1467) — first; folds in the Vitest move (1429) and Oxlint/strict tsconfig (1433).
2. In parallel after 1: [apps/web scaffold, data model, GitHub sign-in, CI tokens](ob://1468) · [pinned capture Docker image](ob://1472) · [tests to the four-layer policy](ob://1434).
3. [Upload API + `pixelslash upload`](ob://1469) → [baseline selection + server diff](ob://1470).
4. In parallel after the diff: [review UI](ob://1421) · [GitHub check](ob://1471) · [AI region explanations + noise labels](ob://1473).
5. [HITL: private beta deploy](ob://1474) — needs the review UI, the check, the capture image and the [name check](ob://1461).
6. [Decide: price points + rate limits from beta cost data](ob://1475) — gate to public launch.

Earlier frontier: engine, dashboard and URL-pair tickets 650, 655, 651, 669, 763, 888 done; 657 and 653 listed; Figma tickets closed. Parent [Visual Compare](ob://649) stays open for the product.
