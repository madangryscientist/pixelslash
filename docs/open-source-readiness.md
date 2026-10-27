# Open-source readiness (PS-243)

What has to be true before `madangryscientist/pixelslash` can go public, and in what order.
This is an investigation: nothing here changed code, history, visibility or npm. Every finding
names the file or the command it came from. Read against `main` at `b01a193` on 2026-10-27.

**Decided by Jacobus, 2026-10-27** (recorded on PS-243): **fully open**, covering the engine, the
CLI, the hosted web app and the bench, with no open-core split. **Fresh history**, with no omnibus
pre-extraction commits, no secrets and nothing LAN-specific. The planner turns §10 into build
tickets and runs §11 last, so §10 and §11 are the executable plan. §1 to §9 are the evidence
behind it.

The short answer: **nothing is fatal, and no live secret is in any commit.** Five things block a
public flip. A licence has to be chosen. History has to be replaced with a fresh root. The LAN and
ob coupling has to come out of the tracked tree. Attribution for pixelmatch and pngjs has to be added. One
unfair matrix row has to be fixed. Everything else is hygiene that can follow the flip.

- [1. Licence](#1-licence)
- [2. Secrets and history](#2-secrets-and-history)
- [3. Private and personal coupling](#3-private-and-personal-coupling)
- [4. Third-party content](#4-third-party-content)
- [5. Packaging](#5-packaging)
- [6. Community files](#6-community-files)
- [7. The hosted app, once the code is public](#7-the-hosted-app-once-the-code-is-public)
- [8. Decisions only Jacobus can make](#8-decisions-only-jacobus-can-make)
- [9. Ordered checklist](#9-ordered-checklist)
- [10. The plan: tickets in dependency order](#10-the-plan-tickets-in-dependency-order)
- [11. Go-public runbook](#11-go-public-runbook)
- [Appendix A: the full dependency licence table](#appendix-a-the-full-dependency-licence-table)

---

## 1. Licence

### Recommendation: Apache-2.0

| | MIT | Apache-2.0 |
| --- | --- | --- |
| Length, familiarity | 1 paragraph, the default on npm | longer; also very common (TypeScript, Playwright, Kubernetes) |
| Patent grant from contributors | none stated | explicit (§3), and it ends for anyone who sues over patents |
| Trademark | silent | §6 says the licence grants no right to the name; this backs the name decision in §8 |
| Contributions | no terms | §5: anything submitted is under Apache-2.0 unless the contributor says otherwise, so no CLA is needed |
| NOTICE file | none | a `NOTICE` is carried forward by redistributors. That is a good place for the pixelmatch credit (§4.4) |
| Compatibility | everything | everything here. Not GPLv2-only, which no dependency is |

PixelSlash is a product with a name and a hosted service, and it will take outside contributions.
Apache-2.0's patent grant, trademark clause and contribution clause cover all three at no cost.
MIT is the right choice only if the shortest possible licence matters more than those. Both are
permissive, and both match the memory "prefer permissive or public-domain libraries".

**What else carries a licence today:**
- `engines/wasm/Cargo.toml` and `engines/wasm/native/Cargo.toml` say `license = "UNLICENSED"`.
  They need to match the repo's licence.
- Every `package.json` is `"private": true` with no `license` field (`packages/*/package.json`,
  `apps/web/package.json`, `bench/package.json`, the root).
- `engines/dotnet/**/*.csproj` have no `PackageLicenseExpression`. They are not packed, so this is
  cosmetic.

### Dependency audit

The full table is in [Appendix A](#appendix-a-the-full-dependency-licence-table). It covers all
669 packages in `bun.lock` (every workspace: root, engine, cli, playwright, web, bench, scripts),
plus the NuGet and Cargo dependencies. Command:

```bash
bun install                                      # so node_modules/.bun has each package.json
python3 -I licences.py .  > licences.md          # the script is in Appendix A
```

The script reads every `packages` entry in `bun.lock`. It takes the licence from the installed
`package.json`. For the 232 OS- or CPU-specific builds not installed on this Linux x64 machine
(marked ¹), and for 6 wasm fallbacks (²), it reads the npm registry's metadata for that exact
version. Only package names went out; no code did. "Reached from" walks
dependencies, optional dependencies and peers from each workspace. It over-counts `prod` because
optional peers are followed, for example `lightningcss` reached from `packages/engine` through
vitest's peer on vite.

| Licence | Packages | Verdict |
| --- | ---: | --- |
| MIT | 516 | fine |
| Apache-2.0 | 65 | fine; carry NOTICEs if we ever bundle |
| MPL-2.0 | 24 | fine unmodified (file-level copyleft); all `lightningcss*`, a build tool |
| ISC | 22 | fine |
| LGPL-3.0-or-later | 10 | `@img/sharp-libvips-*`: see below |
| BSD-3-Clause / BSD-2-Clause / 0BSD | 8 / 5 / 1 | fine |
| BlueOak-1.0.0 | 5 | fine (permissive): glob, minimatch, lru-cache, minipass, path-scurry |
| MIT OR Apache-2.0 | 4 | fine |
| Apache-2.0 AND LGPL-3.0-or-later (± MIT) | 4 | `@img/sharp-win32-*`, `@img/sharp-wasm32`: libvips inside, see below |
| CC0-1.0, Unlicense | 1, 1 | fine |
| Python-2.0 | 1 | `argparse@2.0.1`, permissive |
| CC-BY-4.0 | 1 | `caniuse-lite`, data; attribution only, fine |
| FSL-1.1-Apache-2.0 | 1 | `sentry@0.45.0`: see below |

**Flagged:**

1. **LGPL-3.0 libvips** (`@img/sharp-libvips-*`, through `sharp`). It comes in via `apps/web`'s
   toolchain (miniflare/wrangler pull sharp for image bindings). It is a dynamically linked,
   unmodified prebuilt that we do not ship. Depending on it imposes nothing on our licence. If we
   ever ship a Docker image of the web app that contains it, the image must carry the LGPL text
   and point at libvips's source. That is a should-do for the self-host image, not a blocker.
2. **`sentry@0.45.0`, FSL-1.1-Apache-2.0** (Functional Source License: not OSI-approved, becomes
   Apache-2.0 two years after each release). It is the Sentry CLI, pulled by
   `@sentry/bundler-plugins@11.9.0`, which `@sentry/bun` uses for source-map upload. FSL forbids
   only a product that competes with Sentry. PixelSlash does not, and we neither modify nor
   redistribute it. Acceptable. Note it in the licence doc so a reader does not have to rediscover
   it.
3. **No GPL, AGPL, SSPL, BUSL, non-commercial or unknown licence** is anywhere in the tree. The
   script printed no `?none-declared` and no `?unknown`.
4. **axe-core (PS-238)** is not a dependency yet. It is MPL-2.0, the same licence as `lightningcss`
   already in the tree. MPL's copyleft is per file: using axe-core unmodified as an npm dependency
   imposes nothing on PixelSlash's own files, under MIT or Apache-2.0. Only edits to axe-core's own
   files would have to be published under MPL. The PS-238 brief already says "do not vendor or
   modify axe-core", and that is exactly the condition. **Recommendation: yes to axe-core,
   unmodified.** This report does not change that the call is Jacobus's (§8).

**NuGet** (`engines/dotnet/**/*.csproj`; licences read from `~/.nuget/packages/*/*.nuspec`):

| Package | Version | Licence | Used |
| --- | --- | --- | --- |
| SkiaSharp, SkiaSharp.NativeAssets.Linux.NoDependencies | 4.153.1 | MIT | `PixelSlash.Diff` |
| StbImageSharp | 2.30.16 | Unlicense OR MIT | `PixelSlash.Diff` |
| Microsoft.NET.Test.Sdk | 17.14.1 | MIT | tests |
| xunit, xunit.runner.visualstudio | 2.9.3, 3.1.4 | Apache-2.0 | tests |
| **SixLabors.ImageSharp** | 3.1.12 | **Six Labors Split License** (paid above a revenue line) | only with `-p:DecoderCandidates=true`, bench only (`bench/src/perf/decoders.ts:105`) |

ImageSharp is never built by the gate and never shipped, and `bench/README.md:464` already says
so. But a public repo whose `.csproj` references a split-licensed package invites the question.
The memory "pixelslash-will-be-open-sourced" records that he chose StbImageSharp over it for
exactly this reason. **Should-do:** drop the `DecoderCandidates` item group from
`engines/dotnet/PixelSlash.Diff/PixelSlash.Diff.csproj:23` and its row in `bench:decoders`, or
keep the measurement only in `bench/PERF.md` as history.

**Cargo:** `engines/wasm/Cargo.lock` lists one crate, our own. There are no third-party crates.

**Container images:** `docker/capture/Dockerfile` downloads Liberation 2.1.5 (SIL OFL 1.1),
DejaVu 2.37 (Bitstream Vera / public domain) and Noto Color Emoji 2.047 (OFL 1.1), all by checksum.
It also installs opencode 2.1.4 (MIT) and Playwright's Chromium (BSD-3 plus bundled licences). All
of them are redistributable. Once the image is *published*, it should copy each font's licence
file into `/fonts`. That is a should-do with the image (§5).

---

## 2. Secrets and history

### What was scanned

```bash
mise exec gitleaks@latest -- gitleaks git --redact --log-opts="--all" \
  --report-format json --report-path "$TMPDIR/ps243/gitleaks.json" .
mise exec trufflehog@latest -- trufflehog git "file://$PWD" --no-update --no-verification --json
```

These ran over every ref in the local clone: 2,512 commits, 47 local branches, 783 commits with
blob changes per gitleaks. Both tools ran locally: gitleaks 8.30.1 and trufflehog 3.99.7 through
mise. `--no-verification` keeps trufflehog from calling any provider to test a key. Nothing was
uploaded.

**trufflehog: 0 findings. gitleaks: 17 findings, all test fixtures. None is a secret.** Redacted:

| Rule | File | Commits | What it is |
| --- | --- | --- | --- |
| generic-api-key | `packages/cli/test/support.ts:183` (`FILE_KEY`), and `test/compare.test.ts:633` in the first commit | 9 | A Figma **file key** used as a fake id in tests. Next to it is `FIGMA_TOKEN = "test-figma-token"`. A file key is not a credential, but it may name a real Figma file of his, so see §3 |
| generic-api-key | `packages/cli/test/sentry.test.ts:10,133` | 2 | `psu_0123456789abcdef…`, a made-up upload token the Sentry scrubber test must redact |
| generic-api-key | `apps/web/src/server/sentry.test.ts:5`, `apps/web/e2e/sentry.spec.ts:8` | 2 each | `…23456789abcdefSECRET`, the same kind of scrubber fixture |

Pattern sweep over the tree and over every commit's patch, counting **commits** that add or remove
a match (`git log --all -G<re> -E`), plus `git grep` on HEAD:

| What | Tree (files) | History (commits) | Where in the tree |
| --- | ---: | ---: | --- |
| LAN IPs `192.168.0.{20,30,34,45,135}` | 16 | 28 | AGENTS.md, `apps/web/README.md`, `apps/web/github-app/README.md`, `apps/web/perf/rss-burst.ts:28,33`, `apps/web/perf/results/2026-10-25-*/*.json`, `bench/README.md`, `bench/src/argos.ts:15`, `bench/src/argos-cache.ts`, `docs/research/argos-local.md`, `ops/argos-bench/*`, `packages/engine/test/upload-retry.test.ts:81` |
| Proxmox CT/VM ids (`CT 135`, VM 101) | 6 | 16 | AGENTS.md, `apps/web/README.md`, `apps/web/deploy/lan/release.sh`, `apps/web/perf/README.md`, `bench/PERF.md`, `docs/rust-upload-service.md` |
| `root@` / `debian@` ssh users | 9 | 21 | the same LAN docs, plus `bench/src/argos.ts:15` and `ops/argos-bench/run-pairs.sh:13` as defaults |
| ssh key name `id_ed25519_mac` | 9 | 17 | `apps/web/perf/rss-burst.ts:33`, `bench/src/argos.ts:17`, `ops/argos-bench/run-pairs.sh:14`, docs |
| `/home/jacobus` | 4 | 3 | `.opencode/plugins/ob-*.ts` (absolute re-exports of omnibus) |
| `hack-cove` / `hackcove` | 60 | 113 | mostly `@hackcove/ui`, a public MIT npm package. `org-hackcove` is a seed org name in `apps/web/e2e/dogfood-seed.ts:34` |
| `madangryscientist` (GitHub login) | 4 | 59 | AGENTS.md, `apps/web/github-app/manifest.json:3`, `docs/capabilities/build.py`, `matrix.html` |
| Sentry ingest host or DSN | 0 | 0 | the DSN is env-only (`SENTRY_DSN`, `PIXELSLASH_SENTRY_DSN`) |
| GitHub, OpenAI, Slack or AWS key shapes, or a PEM block | 4 | 5 | all fakes or parsers: `apps/web/deploy/lan/update.test.ts:220` ("fake"), `apps/web/src/github/jwt*.ts`, the scrubber's own regex at `packages/engine/src/sentry-scrub.ts:29` |
| `apps/web/wrangler.jsonc` ids | n/a | n/a | `database_id` is all zeros; R2 bucket `pixelslash-blobs`; no `account_id`, no routes |

Commit identities across all refs: 4 names, 2 emails. `madangryscientist@gmail.com` is on 1,037
author/committer slots, the rest are `T3 Code <t3code@users.noreply.github.com>` and
`GitHub <noreply@github.com>`. On `main`, every commit carries the personal Gmail address. History
also holds **217 `Co-Authored-By: Claude …` trailers on `main`** (370 across all refs). They came
from before the "no Co-Authored-By" rule, and it is his hard line that they should not exist.

None of this is a credential. The LAN addresses are RFC 1918, and the memory "LAN tokens not
sensitive" covers the upload tokens. Still, together they map his home network: which host is
Proxmox, which CT serves what, which ssh user and key name. That has no reason to be public.

### Cleaned history or a fresh squashed root

`main` has 203 commits. The first seven, 2026-09-18 to 2026-10-19 and up to `06a2472` "stand
PixelSlash alone outside omnibus", are omnibus history filtered to this subtree. The extraction
note in `AGENTS.md` says that history belongs to omnibus.

| | Cleaned history (`git filter-repo`) | Fresh squashed root |
| --- | --- | --- |
| Keeps | 196 PixelSlash commits, blame, `ob N`/`PS-N` subjects | one commit, "Initial public release" |
| Must rewrite | IPs and hosts in 28+ commits, `.opencode/` paths, the 217 trailers (`--message-callback`), author emails (`--mailmap`), the 7 omnibus commits | nothing |
| Risk | a missed pattern stays public forever; every sha changes anyway, so `ours_commit`, the matrix `commit` cells and `bench/results` shas all point at nothing | old shas in docs point at nothing (the same as with a cleaned history) |
| Effort | 1 to 2 days, plus a second scan and a review | under an hour |

**Decided: fresh history.** The method, and why it goes into a new repo rather than a force-push
over this one, is in §11. Both options change every sha,
so the cleaned history loses its main advantage: links from the matrix, the bench results and
`ob` tickets break either way. The squash removes every IP, trailer, private email and omnibus
commit at once, with no list of patterns to get right. Keep the private repo as it is, as the
archive with full history. A public repo then starts from a tree that passes §3's cleanup, with
an initial commit authored by a public identity (a `users.noreply.github.com` address).

The sha references in tracked files then need one pass: `docs/capabilities/data.json`
(`ours_commit`, every row's `commit`, and the "names `06a2472`" convention in AGENTS.md), and
`bench/results/*.json` if they record shas. `build.py` stops on a sha `git` cannot resolve, so the
first public commit has to reset those to the new root.

---

## 3. Private and personal coupling

Per item: **keep**, **generalise** (make it configurable or neutral, keep it public), **move**
(to a private repo, for example `pixelslash-ops`), or **delete**.

| Item | Where | What it does | Verdict |
| --- | --- | --- | --- |
| `.opencode/` (planner agent, `/ob-planner`, `SOUL.md`, 4 plugins) | `.opencode/**` | opencode wiring for the ob planner. The plugins re-export `/home/jacobus/dev/omnibus/.opencode/plugins/*.ts` by absolute path. No product code imports it | **move** to the private repo, or out of tracking (`.gitignore`) |
| `AGENTS.md` / `CLAUDE.md` | root | the agents' operating agreement: ob tracker, LAN deploy, CT ids, ssh key, landing rules | **generalise**: split into a public `CONTRIBUTING.md` (gate, conventions, invariants, which are good public content) and a private agents file. Keep a short public `AGENTS.md` if agent contributors are welcome |
| `ob` ticket ids in code | 870 `ob N`/`PS-N` references in 407 code files; 224 in 15 Markdown files (`git grep -cE '\b(ob [0-9]{3,4}\|PS-[0-9]+)\b'`) | comments and test names like `(PS-204)` that explain why a line exists. No code calls `ob` (`git grep` for `ob spinoff\|ob add\|…` in `*.ts` finds none) | **keep** for now: they are harmless, and outsiders read them as ticket refs. **Generalise** later: once issues are public, new refs point at them. A mass rewrite is not worth it |
| LAN deploy | `apps/web/deploy/lan/*` (`release.sh`, `update.sh`, `serve.ts`, 4 systemd units, the diff sidecar, the opencode helper) and `apps/web/README.md` § "Run it on the Proxmox server" | the self-host as Jacobus runs it: Proxmox CT, ssh to `root@`, systemd. Its addresses are env-driven (`PIXELSLASH_LAN_SSH`, `PIXELSLASH_LAN_CT`), with no IP in the scripts themselves | **generalise**: this is the seed of the public self-host story (§5). Keep `serve.ts`, the sidecar and the units. Rewrite the README section as a "self-host on a Linux box" guide with placeholders. Move the Proxmox `pct` specifics to the private repo |
| `apps/web/perf/rss-burst.ts:28,33` | hardcoded `http://192.168.0.34:3000` and `ssh -i ~/.ssh/id_ed25519_mac root@192.168.0.20` as defaults | a perf probe against his CT | **generalise**: make the flags required, with no default |
| `apps/web/perf/results/2026-10-25-*/` | JSON with LAN URLs | measurements | **generalise** (strip the host) or **delete** |
| Argos bench VM | `ops/argos-bench/*` (`provision-vm.sh` runs as root on the Proxmox host; `run-pairs.sh:13-14` default `debian@192.168.0.45`, `~/.ssh/id_ed25519_mac`), `bench/src/argos.ts:15-17`, `bench/README.md`, `docs/research/argos-local.md` | builds Argos's diff in a VM and caches its verdicts | **generalise**: drop the defaults so `ARGOS_BENCH_HOST`/`ARGOS_BENCH_KEY` are required, and describe "a Debian VM" rather than VM 101 on pve. The cache means nobody else needs the VM |
| Proxmox, CT and host notes in docs | `AGENTS.md`, `apps/web/README.md`, `apps/web/github-app/README.md`, `apps/web/perf/README.md`, `bench/PERF.md`, `docs/rust-upload-service.md` | narrative | **generalise** ("the self-host", "a 4-core box") |
| `bench/PERF.md` machine notes | `bench/PERF.md` | speed record on his desktop | **keep**, but say "desktop (x86-64, N cores)" rather than naming hosts |
| `docs/visual-compare-map.md`, `docs/research/competitor-pricing.md`, `docs/rust-upload-service.md` | `docs/` | product direction, pricing research, positioning | **decide** (§8). If open-core or hosted-for-profit, pricing research and positioning are **move**. If fully open, keep |
| Sentry | `apps/web/src/server/sentry*.ts`, `packages/cli/src/*`, `apps/web/README.md:19` | DSN only from env; no org or project slug in code (`git grep` for `SENTRY_ORG\|org:` finds none) | **keep**. Off without a DSN, and that is already invariant 4 |
| Figma | `packages/engine/src/figma.ts`, `--file FILE_KEY`, `--token-path` | token from env or a token file | **keep** the code. Check whether the fixture `FILE_KEY` in `packages/cli/test/support.ts:183` is a real file of his. If it is, swap it for a made-up key (invariant 6 says Figma dogfood is out of scope, so the code stays but is not promoted) |
| GitHub App manifest | `apps/web/github-app/manifest.json:3` (`"url": "https://github.com/madangryscientist/pixelslash"`, `"public": false`) | registers the check-run App | **generalise**: point `url` at the public repo, or make it a template. Each self-hoster registers their own App |
| `docs/capabilities/build.py`, `matrix.html` | link to `github.com/madangryscientist/pixelslash/commit/…` | matrix sha links | **generalise** to the public repo URL |
| `hackcove` | `@hackcove/ui@0.4.4`, `@hackcove/theme-catppuccin-mocha@0.2.8` | his design system, **public on npm, MIT** (`curl registry.npmjs.org/@hackcove%2fui` → 200) | **keep**. `org-hackcove` in the e2e seed is fine |
| The judge's engines | `packages/engine/src/judge.ts:4-10` | mlx, else ollama, else opencode, found on PATH; no paths of his | **keep** |
| `ob` in the gate | n/a | nothing in `bun run typecheck/lint/format:check/test` calls `ob` | **keep**: a fresh clone gates without ob (§5) |
| `ob secret` in user docs | `apps/web/README.md:57-58` (store the Sentry DSN with `ob secret set/get`), `apps/web/deploy/lan/release.sh:23` (comment) | instructions only an ob user can follow | **generalise** to "put it in your secret store / env" |
| LAN stub sign-in | `apps/web/deploy/lan/pixelslash-stub.service`, `apps/web/README.md:146+` | the LAN host runs the e2e GitHub sign-in stand-in in production | **move**; see §7: a public self-host guide must never use it |
| Argos VM MAC address | `ops/argos-bench/runbook.md:21,144` | records VM 101's NIC | **delete** the MAC; keep the `qm config` lookup in `provision-vm.sh:117` |
| His name in prose | `bench/PERF.md:9,497,582` ("Jacobus's desktop"), `docs/research/argos-local.md:14`, `docs/research/competitor-pricing.md:343`, `docs/rust-upload-service.md:3,623`, `ops/argos-bench/runbook.md:8` | narrative | **generalise** ("the maintainer's desktop"); `apps/web/src/lib/branch-review.test.ts:77,116` uses it as test data, fine |
| `ob hosts pixelslash`, T3, `wt` | AGENTS.md, skills | the dev process | goes with the AGENTS.md split |

One small lint coupling: `scripts/check-slop.ts:9,32` requires every TODO to carry a ticket ref
and suggests `TODO(ob 123)`. The regex already accepts `#123`, so a public repo needs only the
message changed to `TODO(#123)`. **Generalise**, S.

---

## 4. Third-party content

### 4.1 Bench corpus and Argos cache

- `bench/corpus/` (7.6 MB) and `bench/corpus-holdout/` (9.5 MB) are **rendered by us** from our
  own HTML fixtures: `bunx nx run bench:corpus`, `bun bench/src/generate.ts --set holdout`
  (`bench/README.md:17-18`). No third-party pages or screenshots.
- `bench/argos-cache.json` and `bench/argos-cache/diffs/` (1.4 MB) hold **Argos's answers about our
  pairs**: verdict, score, time, regions, and the diff PNG its `diffImages` (odiff) wrote. They
  were produced by running unmodified Argos at a pinned commit (`ops/argos-bench/Dockerfile`,
  `ARGOS_COMMIT=21e8520…`) in a VM. Argos is MIT (`docs/capabilities/data.json` note
  `argos:self_host`). A program's output on our input is ours to publish. Argos's own 19
  calibration images are "streamed from the VM for the run and never stored in this repo"
  (`bench/README.md:30`). **Redistributable as-is.**
- `bench/src/calibration.ts:4,15` runs Argos's own 19 `__fixtures__` cases in the VM. It stores
  none of their images, but it does copy the case names, thresholds and expected verdicts from
  Argos's test table. Those are facts about Argos's behaviour, under an MIT licence anyway. Fine,
  and worth one line in the NOTICE ("calibration cases from argos-ci/argos, MIT") for good order.
- `ops/argos-bench/argos-diff.ts:1-5` states that nothing of Argos's is copied and that it calls
  their `diffImages` through their checkout's path alias. That is consistent with the no-copying
  rule.

### 4.2 Fonts, icons, images

- No font files are committed. The capture image downloads them (§1).
- The committed PNGs are the bench corpora, the Argos diffs, and the fixtures in `fixtures/` and
  `bench/fixtures*`, all generated by our code.

### 4.3 The capability matrix's competitor claims

`docs/capabilities/data.json`: five competitors, each sourced to its docs root (`tools[].src`).
Fetched `updated: 2026-10-20`, audited `2026-10-22` against `ours_commit: b97e714`. Of 195
competitor cells: 119 `y`, 31 `p`, 29 `?`, 16 `n`. There are 27 per-cell notes. 11 of the 16 `n`
cells have none.

What a public page needs:

- **One row is wrong in a way that reads as unfair: "No Storybook dependency" marks all five
  rivals `n`.** Argos (Playwright, Cypress and Puppeteer SDKs), Percy (`percy snapshot`, SDKs),
  Applitools (Eyes SDKs) and Lost Pixel (page mode) all run without Storybook. As written, the row
  claims something unique, which the matrix's own honesty rule 4 (AGENTS.md) forbids. **Blocker
  for publishing the page:** fix the values or drop the row.
- Every `n` (a claim that a rival *lacks* something) should carry a note and a deep link to the
  page it was read from, not just the docs root. A `p` should too. A public comparison is where a
  vendor objects, so the source has to be one click away. The method text already says `?` is
  not absence, which is right.
- `docs/capabilities/build.py:146` prints "(all fetched {updated})" under one docs-root link per
  tool, which reads as more sourcing than the cells carry. It should say what was fetched where.
- Refresh the competitor fetch (dated 2026-10-20) just before launch, as the AGENTS.md trigger for
  "a positioning decision is about to be made" requires.

### 4.4 The no-copying rule and pixelmatch

**No rival code was copied.** A search for "ported from", "adapted from", "copied from" and links
to Argos, Chromatic, Percy, BackstopJS, Lost Pixel, reg-suit or odiff repos in code turns up only
the Argos wrapper above.

But **the diff's colour and anti-alias maths follows pixelmatch** (mapbox/pixelmatch, ISC) closely
enough that it should be credited:

- `packages/engine/src/yiq.ts:7,20-22`, `engines/wasm/src/lib.rs:632,660-668`,
  `engines/dotnet/PixelSlash.Diff/Diff.cs:35,109-111` use pixelmatch's `35215` maximum delta and
  its YIQ coefficients, blend over white with `255 + (c - 255) * a`, and in Rust name the
  neighbour test `hasManySiblings` (`engines/wasm/src/lib.rs:694`), which is pixelmatch's function
  name.
- The coefficients come from Kotsarenko & Ramos (2010), and the anti-alias test from Vysniauskas
  (2009, cited at `Diff.cs:151`). The papers are fair game. The particular constant, the blend
  and the names are pixelmatch's.
- pixelmatch was never a dependency (`git log --all -S'pixelmatch' -- '*package.json'` is empty).
  So this is a reimplementation, not a vendored copy, and it extends the algorithm a lot (regions,
  noise, shift). pixelmatch is a library, not a rival, so the memory "no copying open-source
  rivals" is not breached.

**The Rust and C# PNG decoders follow pngjs** (MIT) on purpose: `engines/wasm/src/lib.rs:1-3` says the unfilter, Paeth, Adam7 passes and adaptive filter are "written from … pngjs's unfilter, which it must match byte for byte", and 16 `pngjs` references across `engines/**/*.rs` and `*.cs` name its functions (`getImagePasses`, `byteWidth`, `dePalette`). pngjs is a real dependency of the TypeScript side (in the Appendix A table), so its MIT notice ships in `node_modules`, but not with the Rust and C# ports. MIT requires the notice in "all copies or substantial portions", which is a firmer claim than pixelmatch's, so credit it in the same NOTICE.

ISC asks for the copyright notice when "substantial portions" are copied. Whether this reaches
that line is arguable. Crediting it costs nothing and removes the question. **Blocker (15 min):**
a `NOTICE` (or a "Credits" section) naming pixelmatch © Mapbox (ISC) and pngjs (MIT), each with
its licence text, and the two papers, plus one comment line in each ported file.

### 4.5 Vendored code

None: no `vendor/` or `third_party/` and no committed minified JS. `engines/wasm` has no
third-party crates.

---

## 5. Packaging

**npm names.** All free today: `pixelslash`, `@pixelslash/cli`, `@pixelslash/engine`,
`@pixelslash/playwright`, `pixel-slash` and `pixelslash-cli` each return 404 from
`registry.npmjs.org`, and npm search for "pixelslash" returns nothing. The **`@pixelslash` scope**
cannot be checked anonymously: `npmjs.com/org/pixelslash` answered 403 to curl. Free package names
do not prove the org is free. Creating the npm org `pixelslash` is the way to reserve it. **The
GitHub name `pixelslash` is taken** by a user account created 2018 with one public repo
(`api.github.com/users/pixelslash`). A public repo goes under his account or another org name
(§8).

**What to publish.** Today every package is `private` and points `bin`/`exports` at `.ts` source
(`packages/cli/package.json`: `"bin": {"pixelslash": "src/index.ts"}`), which runs only under Bun.
Options, in order of effort:

1. `bunx pixelslash` / `npx pixelslash`: publish one package, `pixelslash`, whose bin is a
   `bun build --target=bun` bundle of `packages/cli` plus the engine, with `engines: {bun: ">=1.4"}`.
   The engine's `#diff-module` import map (`packages/engine/package.json`) and `diff.wasm` must
   resolve in the bundle. That needs a check, but it is about a day of work.
2. `bun build --compile` single binaries per platform on GitHub Releases: no runtime needed.
   Playwright's browser download still happens at first use (`pixelslash install-browser`).
3. `@pixelslash/engine` and `@pixelslash/playwright` as libraries: only when someone asks. Their
   exported surface (`exports` has 10 subpaths) is not designed as a public API yet.

**Versioning and releases.** There is no version on `@pixelslash/cli` and no changelog. Recommend:
semver starting at `0.1.0`, Changesets (or a tag-driven workflow) to cut releases, and a GitHub
Actions release job with npm provenance (`npm publish --provenance`). `/api/v1` is already a
stable contract (invariant 7), and the CLI's `MIN_CLI_VERSION` check (`apps/web/src/server/env.ts:53`)
needs the CLI to report a real version, which it then can.

**Docker and self-host.** Two images exist today:
- `docker/capture/Dockerfile`: the pinned capture image (Bun, Playwright Chromium, fonts by
  checksum, opencode). Ready to publish to GHCR once the font licence files are copied in (§1).
- The web app has **no image**. It runs on Cloudflare Workers (D1 and R2) or, on his LAN, as `bun
  serve.ts` under systemd (`apps/web/deploy/lan/`). AGENTS.md says the query and blob seams
  (`src/db/*`, `orgBlobs`) exist "so a Docker self-host can swap both", but that image is not
  built. A public self-host story needs either a documented `wrangler deploy` to the user's own
  Cloudflare account (works today, needs a README) or a `docker compose` with the Bun server,
  SQLite and a disk blob store (a ticket). Recommend the Cloudflare path for launch and Docker as
  a follow-up.

**A fresh clone without ob.** The gate is `bun install && bun run typecheck && bun run lint && bun
run format:check && bun run test`. Nothing in it calls `ob`, T3, the LAN or the network after
install, except:
- **the .NET SDK** (`.tool-versions`, `global.json`). `@nx/dotnet` registers MSBuild for *every*
  nx command, so without it nothing runs unless `NX_DOTNET_DISABLE=true` (AGENTS.md "The gate").
  For outsiders: either document `mise install`, or gate the dotnet projects behind an opt-in.
  `engines/dotnet` is a bench subject the CLI does not use.
- `bunx playwright install chromium-headless-shell` for capture tests.
- the bench check (`bench:check`) needs no VM: the Argos cache is committed.

This has not been proven on a clean machine. **Should-do:** the first CI run on a public runner
is that proof (§6).

---

## 6. Community files

None exist today: no `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` or
`.github/`. There is no CI at all, and the gate runs only on his desktop.

| File | Content | Priority |
| --- | --- | --- |
| `LICENSE` | Apache-2.0 text (§1) | blocker |
| `NOTICE` | copyright line, pixelmatch credit (§4.4) | blocker (with Apache-2.0) |
| `README.md` | today it opens with the full CLI flag reference and "Local mlx, else ollama, or opencode". An outsider needs: what it is in two sentences, a 30-second quickstart (`--live-png`/`--local-png` on two PNGs, then open `report.html`), a screenshot of the report, the hosted app, then the full reference (move it to `docs/cli.md`) | blocker (a public repo's front door) |
| `SECURITY.md` | where to report: GitHub private vulnerability reporting (free on public repos; turn it on in settings), or a `security@pixelslash.dev` once the domain exists. Scope: CLI, web app, upload API. Response target | blocker (the hosted app takes uploads) |
| `CONTRIBUTING.md` | the gate (from AGENTS.md), the .NET note, the repo invariants, the commit format, "no AI attribution" if he wants it to apply to contributors | should-do |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1 | should-do |
| `.github/ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md` | bug (version, command, `report.html` screenshot), feature; PR checklist = the gate | nice-to-have |
| `.github/workflows/ci.yml` | the gate on `ubuntu-latest`, with Bun, .NET via `actions/setup-dotnet` from `global.json`, and Playwright's headless shell. Actions minutes are free on public repos | should-do (and it is the fresh-clone proof) |
| Branch protection on `main` | free on public repos: require the CI check and the PixelSlash check, no force-push | should-do, after CI exists |
| `.github/dependabot.yml` or Renovate | dependency PRs, which the planner can merge under the existing rule | nice-to-have |

---

## 7. The hosted app, once the code is public

Making the code public does not open anything that is closed today. Every secret is env-only, and
the routes were never hidden in a meaningful sense. But it does let anyone read exactly how auth
and uploads work, so the threat model should be written down and the obvious gaps closed. From
the code:

- **Sign-in:** GitHub OAuth (`apps/web/src/auth/github.ts`, `allow_signup: "true"`). Anyone with
  a GitHub account can sign in. Membership is by invite (`apps/web/src/db/users.ts:36`,
  `schema-invites.ts`). Session in a cookie (`apps/web/src/server/session.ts`).
- **Tokens:** CI, org and user upload tokens are stored as **SHA-256 hashes** with revocation
  (`apps/web/src/db/tokens.ts:19,62,79,126`), and prefixed (`psu_`, `psci_`, `psorg_`, `pst_`),
  so the Sentry scrubber and GitHub's secret scanning can spot them. **Should-do:** register the
  prefixes with GitHub's secret-scanning partner program once public, so a leaked token in any
  public repo is reported.
- **Model keys:** a project's or org's model `apiKey` is sealed with AES-GCM under
  `MODEL_KEY_SECRET` (`apps/web/src/db/model-key.ts:41-69`).
- **Image URLs** are signed with `IMAGE_SIGNING_SECRET` (`apps/web/src/server/env.ts:26`).
- **GitHub App:** private key from env (`GITHUB_APP_PRIVATE_KEY`); outbound check runs only, no
  webhooks (`apps/web/src/github/app.ts`; `manifest.json` has `"default_events": []`). Each
  self-hoster registers their own App; ours stays `"public": false` until it is meant for other
  orgs.
- **SSRF via the model endpoint:** a project owner sets an arbitrary `baseUrl`
  (`apps/web/src/server/model.ts:21`), and the server POSTs crops to it
  (`apps/web/src/ai/explain.ts`). On Cloudflare Workers that cannot reach a private network. On a
  **self-host** (the LAN CT, or a future Docker image), a member could point it at
  `http://169.254.169.254/` or an internal service. **Should-do before a public self-host guide:**
  refuse private, loopback and link-local targets unless an env flag allows them. The LAN
  opencode helper on localhost needs that flag.
- **Upload size and rate:** the README and handler should state the per-snapshot and per-build
  limits. **Should-do:** a Cloudflare rate-limit rule on `/api/v1/*` for the hosted app.
  `git grep -il ratelimit apps/web/src` finds nothing in code.
- **The GitHub sign-in stub:** the LAN host runs `pixelslash-stub.service`, the e2e stand-in
  for GitHub OAuth, so anyone on the LAN signs in as a fixed user. That is fine for a home
  network and wrong for anything reachable from outside. The public self-host guide must require
  real OAuth credentials, and the server should refuse to start with the stub's
  `GITHUB_OAUTH_BASE` unless an explicit dev flag is set. **Should-do**, folded into S7.
- **Errors:** Sentry is opt-in by DSN, and `scrubEvent` (`packages/engine/src/sentry-scrub.ts`)
  drops bodies, cookies, tokens and images.

`SECURITY.md` should carry a short version of this list: what is in scope, what a self-hoster must
set (`IMAGE_SIGNING_SECRET`, `MODEL_KEY_SECRET`, GitHub OAuth), and that invariant 4 (no shot
leaves without `--upload`) is a security property we accept reports against.

---

## 8. Decisions only Jacobus can make

Each has a recommendation. None of them was acted on. **D2, D3 and D7 are decided** (fully open,
web app included, fresh history). For the rest, the recommendation in **bold** is firm and meant
to be adopted as written; §10 assumes it.

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | **Licence**: MIT or Apache-2.0 | **Apache-2.0, adopt it.** Copyright line: `Copyright 2026 Jacobus Langner and the PixelSlash contributors` | permissive, plus a patent grant, a trademark clause and contribution terms without a CLA (§1). Every dependency is compatible |
| D2 | **Open-core or fully open** | **Decided: fully open** (engine, CLI, web app, bench). A paid hosted service stays possible | Every gap against the field is in the matrix and nothing is unique (AGENTS.md matrix rules). A closed core would hold back exactly what makes it worth trying. The hosted app's value is running it: D1, R2, the GitHub App, the model key, no ops |
| D3 | **Is the web app (`apps/web`) public too?** | **Decided: yes**, with the LAN deploy generalised (§3) | It is half the product and the `/api/v1` contract. The CLI's `--upload` is pointless to outsiders without a server they can run |
| D4 | **Name and trademark** | **Keep PixelSlash. File nothing now.** Before the flip, spend 15 minutes on a knockout search (USPTO, EUIPO TMview, WIPO Global Brand Database, classes 9 and 42). A live conflict there is the only reason to rename before launch. File the word mark when the hosted app first charges. Add one line to the README: "PixelSlash is a name of Jacobus Langner; the Apache-2.0 licence does not grant it" | Apache-2.0 §6 already keeps the name out of the licence |
| D5 | **pixelslash.dev** | **Register it now** (RDAP still answers 404 today, so it is unregistered) | It is the docs, hosted-app and `security@` address. Cheap, and someone else can take it the day the repo is public |
| D6 | **Where the repo lives** | **Keep the name `madangryscientist/pixelslash`, as a new repo.** Rename this one to `pixelslash-archive` (it stays private) and create a fresh `pixelslash` under the same account from the new root (§11). Move it to an org only when a second maintainer arrives: a transfer keeps redirects | the same URL means the GitHub App manifest, `build.py` and the docs keep their links. A new repo, rather than a force-push, is the only way to keep the old PRs' refs private (§11) |
| D7 | **History**: cleaned or fresh root | **Decided: fresh history.** Method: a squashed root (§2, §11) | removes IPs, trailers, email and omnibus commits in one step; both options break shas anyway |
| D8 | **Commit identity** in the public repo | his `users.noreply.github.com` address, not Gmail | the Gmail address is on every commit today |
| D9 | **axe-core (PS-238)** | **Yes, unmodified** | MPL-2.0 file-level copyleft; `lightningcss` is already MPL (§1) |
| D10 | **The Sentry CLI's FSL licence**: accept | **Accept** | build tool, not shipped, PixelSlash does not compete with Sentry (§1) |
| D11 | **The pricing research and positioning docs** (`docs/research/competitor-pricing.md`, `docs/visual-compare-map.md`) | **Move them to the private repo.** D2 opens the code, not the pricing strategy | the code is the product. Pricing notes about named rivals help nobody outside and invite argument |
| D12 | **Agent-written contributions**: does the "no AI attribution" rule bind outside contributors? | No. It is his rule for his agents; say nothing in CONTRIBUTING | policing it for outsiders creates friction for no gain |
| D13 | **When**: before or after the hosted app is on pixelslash.dev | After D5 and the blockers; the hosted app can follow | the CLI alone is useful and is the first thing people try |

---

## 9. Ordered checklist

Effort: S under 2 h, M half a day to a day, L over a day. "Ticket" means a follow-up for the
planner to file with `ob add … --project pixelslash`; none were filed by this investigation.

### Blockers (before the repo is public)

| # | Item | Effort | Ticket? |
| --- | --- | --- | --- |
| B1 | Decisions: D2, D3, D7 **decided** 2026-10-27; adopt §8's firm recommendations for D1, D4, D6 | S | no, decisions |
| B2 | Register `pixelslash.dev` (D5), and the `pixelslash` npm org | S | no, his step |
| B3 | Strip the LAN and ob coupling from the tree: move `.opencode/` out; split `AGENTS.md` into public `CONTRIBUTING.md` and private agent notes; required flags instead of LAN defaults in `apps/web/perf/rss-burst.ts`, `bench/src/argos.ts`, `ops/argos-bench/run-pairs.sh`; rewrite the Proxmox/CT/IP prose in `apps/web/README.md`, `bench/README.md`, `bench/PERF.md`, `docs/*`; strip hosts from `apps/web/perf/results/*`; repoint `github-app/manifest.json` and `build.py` at the public URL; replace the real-looking Figma `FILE_KEY` fixture; drop the MAC from `ops/argos-bench/runbook.md`; reword `ob secret` and "Jacobus's desktop" prose; move this report itself (it names the LAN hosts) to the private repo. Re-run §2's sweep until the tree is clean | M | **yes**: "Make the tree public-safe: LAN, ob and personal coupling out" |
| B4 | `LICENSE` (+ `NOTICE` crediting pixelmatch, pngjs, the two papers and the Argos calibration cases; a comment in `yiq.ts`, `lib.rs`, `Diff.cs`); `license` fields in every `package.json` and both `Cargo.toml` | S | **yes**: "Licence the repo" (after D1) |
| B5 | Fix the matrix's "No Storybook dependency" row; add a note and deep link to every `n` cell; refresh the competitor fetch | S–M | **yes**: "Matrix fit for a public page" |
| B6 | `SECURITY.md` with the threat-model notes from §7; turn on private vulnerability reporting | S | **yes**, together with B7 |
| B7 | README for outsiders: what it is, quickstart, a report screenshot, full reference moved to `docs/cli.md` | M | **yes**: "Public README and community files" (with B6, S3, S4) |
| B8 | Create the public repo from a squashed root of the cleaned tree (D7); scan that one commit again with gitleaks and the §2 sweep; reset `ours_commit` and the matrix `commit` cells to the new root | S | **yes**: "Public repo from a squashed root" (runs last; needs B3 to B7) |

### Should-dos (soon after, or with, the flip)

| # | Item | Effort | Ticket? |
| --- | --- | --- | --- |
| S1 | GitHub Actions CI running the gate on `ubuntu-latest` (Bun, .NET from `global.json`, Playwright headless shell). This is also the fresh-clone proof | M | **yes** |
| S2 | Branch protection on `main`: require CI and the PixelSlash check | S | no, a setting, after S1 |
| S3 | `CONTRIBUTING.md` (from AGENTS.md's gate and invariants), `CODE_OF_CONDUCT.md` | S | in B7's ticket |
| S4 | Make `engines/dotnet` opt-in for outside contributors, or document `mise install`; drop the ImageSharp `DecoderCandidates` reference | S–M | **yes**: "The gate without a .NET SDK" |
| S5 | Publish the CLI: a bundled `pixelslash` package on npm (Bun target), semver from `0.1.0`, a release workflow with provenance, a changelog | M | **yes** |
| S6 | SSRF guard on the model `baseUrl` for self-hosts (refuse private and link-local unless allowed) | S | **yes** |
| S7 | Self-host guide: deploy `apps/web` to your own Cloudflare account (wrangler, D1, R2, secrets, your own GitHub App); refuse the sign-in stub outside dev | M | **yes** |
| S8 | Publish the capture image to GHCR with the font licences copied in | S | **yes** (or with S5) |
| S9 | Register the token prefixes with GitHub secret scanning; a rate-limit rule on `/api/v1/*` | S | **yes** |
| S10 | Trademark search, USPTO/EUIPO/WIPO (D4) | S | no, his step |

### Nice-to-haves

| # | Item | Effort | Ticket? |
| --- | --- | --- | --- |
| N1 | Issue and PR templates; Dependabot or Renovate | S | fold into B7's ticket |
| N2 | `docker compose` self-host (Bun server, SQLite, disk blobs) through the `Db`/`orgBlobs` seams | L | **yes** |
| N3 | `bun build --compile` binaries on GitHub Releases | M | **yes** (or with S5) |
| N4 | A docs site on pixelslash.dev (the README, the CLI reference, the matrix page) | M | later |
| N5 | Gradually swap `ob N`/`PS-N` refs in new code comments for public issue links | n/a | no, a convention in CONTRIBUTING |
| N6 | Ship the LGPL notice for libvips with any image of the web app that contains sharp | S | with N2 |

**Tickets for the planner to file** (none filed here): §10 turns these rows into ticket-sized
briefs, in the order they can land.

---

## 10. The plan: tickets in dependency order

These are the §9 rows, cut to one ticket each and put in the order they can land. Each brief is
written to paste into `ob add "<title>" --project pixelslash --body "<brief>"`; raise its three
`####` headings to `##` when pasting (they are `####` here only to keep this page's outline). The
recommendations in §8 are assumed adopted: Apache-2.0, the name kept, the same account with a
new repo, a fresh root.

```
T1 tree public-safe ──┐
T2 docs and agents ───┼──> T8 README + community ──┐
T3 licence ───────────┘                            │
T4 matrix ─────────────────────────────────────────┤
T5 hosted-app hardening ──> T9 self-host guide ────┤
T6 gate without .NET ─────> T7 CI ─────────────────┼──> T12 go public ──> T13 publish
T10 npm package (built, not published) ────────────┤
T11 capture image on GHCR (workflow only) ─────────┘
```

T1 to T6 are independent and can run in parallel. T12 runs only when every other ticket has
landed. T13 runs after the flip, because npm provenance needs a public source repo.

### T1. Make the tree public-safe: LAN, ob and personal coupling out of code and data

#### What to build
- Remove the home-network defaults from code. A missing value now fails with a message naming
  the env var:
  - `bench/src/argos.ts:15-17`: `ARGOS_BENCH_HOST` and `ARGOS_BENCH_KEY`. Line 67's hint names
    VM 101 and `root@192.168.0.20`.
  - `ops/argos-bench/run-pairs.sh:13-14`: the same two variables.
  - `apps/web/perf/rss-burst.ts:28,33,34`: the `--server`, `--ssh` and `--ct` defaults.
  - `ops/argos-bench/provision-vm.sh`: the VM id, bridge and Proxmox host as required arguments.
- Remove or reword the host data:
  - Drop the MAC address from `ops/argos-bench/runbook.md:21,144`.
  - In `apps/web/perf/results/*/*.json`, replace the hosts and IPs with role names (`server`,
    `client`).
  - Replace the address in `packages/engine/test/upload-retry.test.ts:81` with `example.test`.
- Replace `FILE_KEY` in `packages/cli/test/support.ts:183` with an obviously made-up key of the
  same shape. Keep the tests passing.
- Move `.opencode/` out of the repo: its plugins re-export `/home/jacobus/...` by absolute path.
  Where it goes is T2's call; in this ticket, delete it from the tree and note the move in the
  commit.
- Set `docs/capabilities/build.py:13` (`REPO`) and `apps/web/github-app/manifest.json:3` from a
  single constant for the repo URL. The URL itself stays `madangryscientist/pixelslash` (D6), so
  only the duplication goes.

#### Acceptance
- From the worktree, this prints nothing outside `docs/open-source-readiness.md`:

  ```bash
  git grep -nE '192\.168\.|CT 135|VM 101|id_ed25519_mac|debian@|root@192|/home/jacobus|([0-9a-f]{2}:){5}[0-9a-f]{2}'
  ```

  That file is T2's to move.
- `bun run bench -- --refresh-argos` without `ARGOS_BENCH_HOST` fails at once with a message
  naming the variable. It does not try an ssh.
- gitleaks on the working tree finds only the two Sentry scrubber fixtures:

  ```bash
  mise exec gitleaks@latest -- gitleaks dir --redact .
  ```

- The gate is green, and `bun run bench:check` passes with no new `bench/results` file.

#### Do not
- Do not change the diff, the bench scoring or any committed corpus.
- Do not touch prose docs (T2) or the matrix (T4).
- Do not rewrite history. That is T12.
- Do not upload anything to an online scanner.

### T2. Docs and agent files fit for strangers

#### What to build
- Split `AGENTS.md`:
  - **The public `AGENTS.md`** keeps what any contributor or agent needs: the project table, the
    gate, isolated linking, /tmp hygiene, generated-file formatting, the capability-matrix honesty
    rules, `bench/PERF.md`, and the repo invariants.
  - **Moved to a private file in omnibus** (suggested: `omnibus/projects/pixelslash/AGENTS.ob.md`):
    the `ob` tracker, Dispatch, The ob planner, the LAN deploy step of Landing, and the
    `.opencode/` table.
  - `CLAUDE.md` stays `@AGENTS.md`.
  - File an omnibus ticket (planner's job, not the builder's) so the `ob-planner` skill's Step 0
    reads the omnibus file as well.
- Generalise the LAN prose. Keep the method, lose the address: "a Proxmox host", `$SSH_HOST`,
  `$CT`. The files are:
  - `apps/web/README.md`, including the `ob secret` lines at 57-58: "a secret store; set the
    variables any way you like".
  - `apps/web/github-app/README.md`, `apps/web/perf/README.md`
  - `bench/README.md`, `bench/PERF.md`
  - `docs/research/argos-local.md`, `docs/rust-upload-service.md`
  - `ops/argos-bench/runbook.md`
  - `apps/web/deploy/lan/` (rename it `deploy/ssh/`)

  "Jacobus's desktop" becomes "the maintainer's machine".
- Move to the private archive or omnibus, and out of the public tree:
  - `docs/open-source-readiness.md` (this report; it maps the LAN)
  - `docs/research/competitor-pricing.md` and `docs/visual-compare-map.md` (D11)
- `scripts/check-slop.ts:9,32`: the `TODO(ob 123)` wording becomes `TODO(#123)`, or both are
  accepted.
- Leave `ob N` / `PS-N` refs in code comments as they are (N5). Add one line in `AGENTS.md`:
  "`ob N` and `PS-N` are the maintainer's private ticket ids; new work cites GitHub issues."

#### Acceptance
- T1's `git grep` prints nothing anywhere in the tree, this report included.
- `git grep -nE 'ob secret|ob spinoff|ob agent|Jacobus'` prints nothing outside the one-line
  `ob N` note and the copyright lines T3 adds.
- A planner session in the new layout still finds the tracker, the gate and the landing rule:
  run Step 0 of `ob-planner` and paste what it reads into the commit body.
- The gate is green, and `format:check` passes.

#### Do not
- Do not delete the ob workflow. Move it.
- Do not reflow prose that is not changing.
- Do not touch code; that was T1.
- Do not edit the omnibus skill from this repo.

### T3. Licence the repo: Apache-2.0, NOTICE, attribution

#### What to build
- `LICENSE`: the Apache-2.0 text, verbatim.
- `NOTICE`: `PixelSlash`, `Copyright 2026 Jacobus Langner and the PixelSlash contributors`, then
  attributions:
  - pixelmatch (ISC, Volodymyr Agafonkin), for the YIQ colour-delta and anti-aliasing approach
    in `packages/engine/src/yiq.ts`, `engines/wasm/src/lib.rs` and
    `engines/dotnet/.../Diff.cs`, with its licence text
  - pngjs (MIT), cited at `engines/wasm/src/lib.rs:1-3`
  - the two papers cited in the engine (§4.4)
  - the Argos calibration cases in `bench/` (§4.1), with their source and licence
- A one-line comment at each ported function pointing to `NOTICE`.
- Set `"license": "Apache-2.0"` in every `package.json`, the root included, and `license` in both
  `Cargo.toml`. The `.csproj` gets `PackageLicenseExpression`.
- An SPDX header is not required. Do not add one to every file.

#### Acceptance
- Re-running `$TMPDIR/ps243/licences.py` (Appendix A) shows no first-party package as
  `UNLICENSED` or empty.
- `NOTICE` names every source §4 lists.
- The gate is green.

#### Do not
- Do not choose another licence.
- Do not add a CLA or a DCO bot.
- Do not copy any rival's code to "match" it.

### T4. The capability matrix, fit for a public page

#### What to build
- Fix the "No Storybook dependency" row and the `build.py:146` wording (§4.3).
- Every competitor `n` and `partial` cell gets a note and a deep link to the page it came from.
- Re-fetch the five vendors' docs and set `updated`.
- Re-read our column at the current main, then set `audited` and `ours_commit`.
- Re-run `python3 docs/capabilities/build.py` and commit `matrix.html`.

#### Acceptance
- Every non-`y` competitor cell has a note and a URL.
- `build.py` runs clean.
- The "nothing we have is unique" sentence is still true, or the text is changed because a
  landing changed it.

#### Do not
- Do not add rows that flatter us.
- Do not hand-tune `behind`.
- Do not fill a `?` from memory.

### T5. Hosted-app hardening for strangers' deployments

#### What to build
- **SSRF guard on the project and org model `baseUrl`.** Refuse loopback, RFC 1918, link-local
  (169.254/16, including the metadata address), CGNAT, `.local`/`.internal` names and non-http(s)
  schemes, both at save time and at call time. DNS resolution counts, so check after resolving
  where the runtime allows it.
  - Add a server setting, `PIXELSLASH_ALLOW_PRIVATE_MODEL_HOSTS=1`, for self-hosts that run a
    local model. It is off by default.
- **Refuse the GitHub sign-in stub unless the build is dev or test.** A production build with the
  stub's env set fails at start with a clear message.
- **Rate limits on `/api/v1/*` and sign-in.** Add a Cloudflare rate-limit binding in
  `wrangler.jsonc`, and a no-op seam for the self-host.
- Document the token prefixes (`psu_` and the others) in `SECURITY.md`'s draft section; T8 owns
  the file.

#### Acceptance
- Unit tests cover the guard: each refused range, the IPv6 forms, and a name that resolves to a
  private address. The allow flag lets them through.
- An e2e test proves that a production-mode build with the stub env does not start.
- `/api/v1` is unchanged (invariant 7). The `ENDPOINTS` test is still green.
- The web gate is green: build, `test:e2e`, `test:e2e:dev` and the wrangler dry-run.

#### Do not
- Do not change what is sent to the model (invariant 4).
- Do not add an auth provider.
- Do not rename or retype an `/api/v1` field.

### T6. The gate without a .NET SDK

#### What to build
- Make `engines/dotnet` opt-in for contributors:
  - With no `dotnet` on PATH, set `NX_DOTNET_DISABLE=true` automatically, through a tiny wrapper
    in the root scripts. The gate then runs the TS projects and prints one line: "dotnet SDK not
    found: skipping engines/dotnet".
  - With `dotnet` present, nothing changes.
- Drop the ImageSharp `DecoderCandidates` reference (§1, NuGet).
- Document both paths in `AGENTS.md`'s gate section.

#### Acceptance
- On a machine or container without dotnet, `bun install && bun run typecheck && bun run lint &&
  bun run test` is green and prints the skip line.
- On this desktop the gate still runs the xunit tests.
- `bun run bench:check` is unchanged.

#### Do not
- Do not delete `engines/dotnet`.
- Do not make the skip silent.
- Do not touch the diff contract.

### T7. GitHub Actions CI (needs T6)

#### What to build
- Add `.github/workflows/ci.yml` running the gate on `ubuntu-latest`:
  - Bun pinned to the repo's version.
  - `actions/setup-dotnet` reading `global.json`.
  - `bunx playwright install --with-deps chromium-headless-shell`.
  - `bun install --frozen-lockfile`, then typecheck, lint, format:check and test.
- A second job runs the web gate when `apps/web/**` or `packages/**` changes.
- Use no secrets, and give pull requests from forks read-only permissions.

#### Acceptance
- The workflow is green on a PR in the private repo.
- One deliberate lint error turns it red, and the run is linked in the commit body.

#### Do not
- Do not add Nx Cloud, a remote cache or a paid runner.
- Do not run `bench:perf` (memory: on demand only).
- Do not set the workflow to `pull_request_target`.

### T8. Public README and community files (needs T2, T3)

#### What to build
- Rewrite `README.md` for an outsider:
  - one paragraph on what it is
  - a 60-second quickstart (`npx pixelslash --live-png a.png --local-png b.png --out out`)
  - a report screenshot
  - a link to the hosted app and the self-host guide
  - the trademark line from D4
- Move the full CLI reference to `docs/cli.md`. It is still the contract, so keep it verbatim
  and only move it.
- Add `SECURITY.md`:
  - private vulnerability reporting
  - the §7 threat model, condensed
  - the token prefixes
  - what is in scope
- Add `CONTRIBUTING.md`: the gate, the invariants, "lint rules are errors", and "no AI
  attribution trailers are required or expected" (D12).
- Add `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1, with a contact address on pixelslash.dev
  or a GitHub noreply address.
- Add `.github/ISSUE_TEMPLATE/{bug,feature}.yml`, a PR template, and `dependabot.yml` for bun,
  GitHub Actions and NuGet.

#### Acceptance
- A fresh-eyes read by someone outside the project (or an agent with no repo context), and the
  quickstart works as written against T10's packed tarball.
- The README's "API" table is still in sync with `ENDPOINTS`; the test is green.

#### Do not
- Do not drop any CLI flag from the docs.
- Do not promise features that are not in the code (the matrix rules apply).
- Do not add badges for services we do not run.

### T9. Self-host guide: your own Cloudflare account (needs T5)

#### What to build
- Write `apps/web/SELF-HOST.md`, from zero to a working instance:
  - create D1 and R2, set `database_id`, apply the migrations
  - create your own GitHub App from `github-app/manifest.json` (the URL replaced)
  - set the secrets
  - `wrangler deploy`
  - point the CLI at it with `--upload`
- Put the variables in one table, saying which are required.
- Generalise the ssh/LXC deploy from T2 into an "on your own box" section.

#### Acceptance
- A dry run on a fresh Cloudflare account, or at minimum `wrangler deploy --dry-run` from a clean
  clone following only the guide, with each step's output pasted into the commit body.

#### Do not
- Do not hardcode our account, zone or bucket names.
- Do not ship docker compose here (N2 is separate).

### T10. The `pixelslash` npm package, built but not published

#### What to build
- Check the name with `npm view pixelslash`. If it is taken, use `@pixelslash/cli` and say so.
- Make `packages/cli` publishable:
  - `bun build` into one bundle, with `@pixelslash/engine` inlined.
  - `bin`, `files`, `engines` (the Bun version, or Node if the bundle runs there).
  - `"version": "0.1.0"`, `"private"` removed.
- Playwright stays a peer: say so in the README, and keep the "install chromium-headless-shell
  once" note.
- Add `CHANGELOG.md`.
- Add `.github/workflows/release.yml`:
  - on a `v*` tag, run the gate, then `npm publish --provenance --access public`
  - use npm trusted publishing (OIDC), not a long-lived `NPM_TOKEN`
- The workflow lands but is not run.

#### Acceptance
- `npm pack` produces a tarball.
- In an empty directory, `npm i ./pixelslash-0.1.0.tgz && npx pixelslash --live-png ... --local-png ... --out out`
  writes a report, which is opened and looked at.
- `--help` matches `docs/cli.md`.

#### Do not
- Do not publish.
- Do not create the npm org; that is his step (B2).
- Do not publish `@pixelslash/engine` or `@pixelslash/playwright` yet.

### T11. The capture image on GHCR (workflow only)

#### What to build
- Add `.github/workflows/image.yml`: build `docker/` and push `ghcr.io/madangryscientist/pixelslash-capture:<version>`
  on a `v*` tag.
- Copy the font licences (§1, container fonts) into the image under `/usr/share/doc/`.
- Add the image to the README.

#### Acceptance
- `docker build` locally produces the same PNG hashes as the current image (the AGENTS.md
  check), and the licences are present in the image.

#### Do not
- Do not push an image before the flip.
- Do not change the pinned browser or fonts.

### T12. Go public (needs T1 to T11 landed)

#### What to build
Run §11 from step 1 to step 9, as written. This ticket is a runbook execution, not a build. Its
"commit" is the new repo's root plus commit 2.

#### Acceptance
- Every check in §11 step 11 passes.
- The new public repo's two commits scan clean.
- Jacobus has seen the root's tree (`git ls-tree -r --name-only main | less`) before the flip,
  and said yes.

#### Do not
- Do not force-push over the existing repo.
- Do not flip before the scan is clean.
- Do not publish to npm in this ticket.

### T13. Publish, and the post-flip settings (needs T12)

#### What to build
- Tag `v0.1.0` on the public repo. The release workflow (T10) publishes `pixelslash` with
  provenance, and T11 pushes the image.
- Turn on:
  - private vulnerability reporting
  - secret scanning with push protection
  - Dependabot alerts
  - branch protection on `main`, requiring CI and the PixelSlash check
- Apply to GitHub's secret-scanning partner programme for the token prefixes (S9).
- Later and separate: N2 (docker compose), N3 (compiled binaries), N4 (docs site).

#### Acceptance
- `npx pixelslash@0.1.0 --help` works from a clean machine.
- The npm page shows the provenance badge linking to the public workflow run.
- `docker pull` of the image works anonymously.

#### Do not
- Do not publish from a laptop.
- Do not publish the engine or playwright libraries in this ticket.

---

## 11. Go-public runbook

T12 runs this, start to finish. Every step either names a command or a check, and nothing in it
writes to the existing repo's history.

**Method, decided: a fresh root, not `git filter-repo`.** `filter-repo` keeps the 196 PixelSlash
commits, but it needs a complete list of patterns to scrub, and it changes every sha anyway (§2).
A fresh root has no list to get wrong.

**Where it goes: a new repo, not a force-push.** A force-push over `madangryscientist/pixelslash`
would leave the old history reachable on GitHub:
- `refs/pull/1..4/head` are read-only refs that GitHub keeps for every PR, and they pin the old
  commits.
- A commit's page stays reachable by sha.
- Only GitHub Support can purge those, on request.

A new repo under the old name contains only what is pushed to it. The old repo, renamed, keeps
the full history private, as the archive.

**What to keep:** the tree at main after T1 to T11, and nothing else: no branches, no tags, no
PRs, no issues (there are none; ob is the tracker), no Actions secrets. The `ob N` / `PS-N` refs
in comments stay; they are only numbers (N5).

### 1. Freeze

- Every open PR is merged or closed (`gh pr list --state open` is empty).
- Every builder worktree is landed or abandoned: `ob spinoff list` shows nothing in flight.
- Announce the freeze on the planner thread. Nothing lands on the old repo after step 5.

### 2. Build the tree, outside every clone

```bash
cd ~/dev/pixelslash && git fetch origin && git status --short   # clean, on main
root="$TMPDIR/ps-public"; rm -rf "$root"; mkdir -p "$root"
git archive origin/main | tar -x -C "$root"     # the tree only: no .git, no ignored files
cd "$root" && git init -q -b main
```

`git archive` writes the tracked tree and nothing else, so no object of the old history can come
along. There is no `.gitattributes` with `export-ignore` in the repo, so the archive is the whole
tree. Check this again on the day: `git ls-files | grep gitattributes` prints nothing.

### 3. Scan the tree before committing anything

```bash
mise exec gitleaks@latest -- gitleaks dir --redact "$root"
mise exec trufflehog@latest -- trufflehog filesystem "$root" --no-update --no-verification
cd "$root" && grep -rnE '192\.168\.|CT 135|VM 101|id_ed25519_mac|debian@|root@192|/home/jacobus|ob secret|competitor-pricing|([0-9a-f]{2}:){5}[0-9a-f]{2}' . | grep -v node_modules
```

- Expected: gitleaks reports only the Sentry scrubber fixtures (§2), trufflehog reports 0, and
  the grep prints nothing.
- Anything else stops the run, goes back to T1 or T2 as a fix on the old repo, and step 2 starts
  over.

### 4. Commit the root, then the sha fix

```bash
cd "$root"
export GIT_AUTHOR_NAME="Jacobus Langner" GIT_COMMITTER_NAME="Jacobus Langner"
export GIT_AUTHOR_EMAIL="<id>+madangryscientist@users.noreply.github.com"   # gh api user -q .id
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git add -A && git commit -q -m "Initial public release"
root_sha=$(git rev-parse --short HEAD)
```

Commit 2 is the only edit made in the new repo:
- set `ours_commit` and every row's `commit` in `docs/capabilities/data.json` to `$root_sha`
- run `python3 docs/capabilities/build.py`
- in `AGENTS.md`, replace the "names `06a2472`" convention with "names the public root"
- leave `bench/results/*.json`'s `commit` fields: they are an informational record of the
  private sha that was measured, which `check.ts` does not read

Then:

```bash
bun install && bun run typecheck && bun run lint && bun run format:check && bun run test
git add docs/capabilities/data.json docs/capabilities/matrix.html AGENTS.md
git commit -q -m "docs: the matrix names the public root"
```

Re-run step 3's gitleaks as `gitleaks git --redact "$root"`. It now covers both commits, and the
result must match step 3.

### 5. Swap the repos

```bash
gh repo rename pixelslash-archive --repo madangryscientist/pixelslash --yes   # stays private
gh repo create madangryscientist/pixelslash --private \
  --description "Visual review for any web app: capture, pixel-diff, report"
cd "$root" && git remote add origin git@github.com:madangryscientist/pixelslash.git
git push -u origin main
```

The new repo starts **private**. The rename leaves a redirect, and creating the new repo under
the old name replaces it, which is what we want: old links now reach the public code.

### 6. Re-wire what pointed at the old repo

- **The PixelSlash GitHub App:** install it on the new repo, because installs are per repository
  id. Check the web app's project-to-repo link: re-link it if it stores the id, not the name.
- **Webhooks and Actions secrets:** the new repo has none. T7's CI needs none; add only what
  T10/T11's workflows need (nothing, with OIDC trusted publishing).
- **Local clones:**
  - Move `~/dev/pixelslash` aside: `mv ~/dev/pixelslash ~/dev/pixelslash-archive`, then
    `git remote set-url origin …/pixelslash-archive.git` inside it.
  - Clone the new repo fresh to `~/dev/pixelslash`.
  - The old worktrees belong to the archive. Remove them with `wt` once nothing is in flight.
- **ob:** `spinoff_launcher_by_repo` is keyed by name and is unchanged. Re-point the T3 project
  `pixelslash` at the new clone's path if it moved, and re-pin `planner · pixelslash` with
  `ob t3 planner --repo pixelslash`.
- **The LAN self-host (CT 135):** its release script builds from a local checkout at a sha, so
  the next deploy uses the new clone. Nothing changes on the CT.

### 7. Check the private new repo as a stranger would

- Open a throwaway PR in the new repo: CI (T7) is green, and the PixelSlash check runs.
- Then, in an empty directory:

  ```bash
  git clone https://github.com/madangryscientist/pixelslash.git
  ```

  Follow `README.md`'s quickstart, word for word, from that clone.
- Jacobus reads `git ls-tree -r --name-only main` and says yes. That yes is T12's acceptance.

### 8. Flip

```bash
gh repo edit madangryscientist/pixelslash --visibility public --accept-visibility-change-consequences
```

### 9. Lock it down (straight after the flip)

```bash
gh api -X PUT repos/madangryscientist/pixelslash/private-vulnerability-reporting
gh api -X PATCH repos/madangryscientist/pixelslash \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh api -X PUT repos/madangryscientist/pixelslash/vulnerability-alerts
```

Branch protection on `main` (free on a public repo):
- require the CI check, and the PixelSlash check once it is reliable on PRs from forks
- no force-push
- no deletion

### 10. Publish (T13, in this order)

1. Create the `pixelslash` org on npmjs.com (his step, B2) and configure trusted publishing for
   the new repo's `release.yml`.
2. Push the `v0.1.0` tag. The release workflow runs the gate and publishes `pixelslash` 0.1.0
   with `--provenance`. Provenance needs the public repo, which is why this comes after step 8.
3. The same tag runs `image.yml`, which pushes the capture image to GHCR. Make the package
   public in its settings.
4. Later, each in its own ticket: `@pixelslash/engine` and `@pixelslash/playwright`, once their
   APIs are worth a semver promise.

### 11. Post-flip checks

| Check | Command or place | Pass |
| --- | --- | --- |
| Fresh-clone gate | CI on `main` | green |
| CLI from npm | `npx pixelslash@0.1.0 --live-png a.png --local-png b.png --out out` on a clean machine | report written, opened, looks right |
| Secrets in the public repo | `gitleaks git --redact` on a fresh clone of the public repo | the same fixtures as step 3, nothing new |
| The LAN in public | GitHub code search `repo:madangryscientist/pixelslash 192.168` | no results |
| Old history unreachable | `https://github.com/madangryscientist/pixelslash/commit/<an old main sha, e.g. b01a193>` | 404 |
| Old PRs stay private | `https://github.com/madangryscientist/pixelslash/pull/4` | 404 on the new repo (the PR lives in the archive) |
| Archive is private | `gh repo view madangryscientist/pixelslash-archive --json visibility` | `PRIVATE` |
| The GitHub App works | a test PR on the new repo | the check run appears |
| The matrix links | open `docs/capabilities/matrix.html` from the public repo; click a `commit` | resolves to the root |

**If something leaks after the flip:**
1. Set the repo back to private at once with `gh repo edit … --visibility private
   --accept-visibility-change-consequences`.
2. Rotate whatever leaked.
3. Fix the tree on the archive side and start again from step 2 with a new repo. Do not try to
   scrub the public one.

Forks made in the window keep what they took. That is why step 3 runs before step 8, never after.

---

## Appendix A: the full dependency licence table

Generated 2026-10-27 from `bun.lock` at `b01a193` with the script below:
`python3 -I licences.py . > licences.md`, run from the repo root after `bun install`. ¹ is a
platform-specific build not installed here; ² is a fallback not installed here. Both had their
licence read from `registry.npmjs.org/<name>/<version>`. "Scope" is `prod` when any workspace
reaches the package through `dependencies`, `optionalDependencies` or a peer, else `dev`. Peers
make it an over-count.

<details><summary>licences.py</summary>

```python
# Usage: python3 -I licences.py <repo>  -> markdown table of every package in bun.lock
import json, re, sys, os, collections
repo = sys.argv[1]
raw = open(os.path.join(repo, "bun.lock")).read()
lock = json.loads(re.sub(r",(\s*[}\]])", r"\1", raw))
pk = lock["packages"]
def resolve(parent, dep):
    k = parent
    while True:
        cand = f"{k}/{dep}" if k else dep
        if cand in pk: return cand
        if not k: return None
        k = k.rsplit("/", 1)[0] if "/" in k and not (k.startswith("@") and k.count("/") == 1) else ""
def deps_of(key):
    meta = pk[key][2] if len(pk[key]) > 2 and isinstance(pk[key][2], dict) else {}
    out = {}
    for f in ("dependencies", "optionalDependencies", "peerDependencies"):
        out.update(meta.get(f, {}))
    return out
reach = collections.defaultdict(set)  # key -> {(ws, kind)}
for ws, w in lock["workspaces"].items():
    wsname = ws or "(root)"
    for kind, field in (("prod", "dependencies"), ("dev", "devDependencies"), ("prod", "optionalDependencies")):
        stack = [(None, d) for d in w.get(field, {})]
        seen = set()
        while stack:
            parent, d = stack.pop()
            k = resolve(parent, d) if parent else (d if d in pk else None)
            if not k or k in seen: continue
            seen.add(k); reach[k].add((wsname, kind))
            stack += [(k, x) for x in deps_of(k)]
def licence(key):
    ident = pk[key][0]
    if "workspace:" in ident: return ident, "(workspace)"
    name, ver = ident.rsplit("@", 1)
    base = os.path.join(repo, "node_modules/.bun")
    pre = f"{name.replace('/', '+')}@{ver}"
    dirs = [x for x in os.listdir(base) if x == pre or x.startswith(pre + "+")]
    d = os.path.join(base, dirs[0], "node_modules", name, "package.json") if dirs else ""
    if not d or not os.path.exists(d):
        meta = pk[key][2] if len(pk[key]) > 2 and isinstance(pk[key][2], dict) else {}
        plat = " ¹" if "os" in meta or "cpu" in meta else " ²"
        try:  # not installed on this platform: read the licence from the registry's metadata
            import urllib.request
            u = f"https://registry.npmjs.org/{name.replace('/', '%2f')}/{ver}"
            j = json.load(urllib.request.urlopen(u, timeout=20))
            l = j.get("license")
            if isinstance(l, dict): l = l.get("type")
            return ident, (l or "?none-declared") + plat
        except Exception:
            return ident, "?unknown" + plat
    j = json.load(open(d))
    l = j.get("license") or j.get("licenses")
    if isinstance(l, dict): l = l.get("type")
    if isinstance(l, list): l = " OR ".join(x.get("type", "?") if isinstance(x, dict) else x for x in l)
    return ident, l or "?none-declared"
rows = {}
for key in pk:
    ident, lic = licence(key)
    if lic == "(workspace)": continue
    r = reach.get(key, set())
    wss = sorted({w for w, _ in r})
    kind = "prod" if any(k == "prod" for _, k in r) else ("dev" if r else "unreached")
    rows[ident] = (lic, kind, ", ".join(wss))
c = collections.Counter(v[0].rstrip(" ¹²") for v in rows.values())
print("| Licence | Packages |\n| --- | ---: |")
for l, n in c.most_common(): print(f"| {l} | {n} |")
print(f"\nTotal: {len(rows)} packages.\n")
print("| Package | Licence | Scope | Reached from |\n| --- | --- | --- | --- |")
for ident in sorted(rows):
    l, k, w = rows[ident]
    print(f"| `{ident}` | {l} | {k} | {w} |")
```

</details>

| Licence | Packages |
| --- | ---: |
| MIT | 516 |
| Apache-2.0 | 65 |
| MPL-2.0 | 24 |
| ISC | 22 |
| LGPL-3.0-or-later | 10 |
| BSD-3-Clause | 8 |
| BSD-2-Clause | 5 |
| BlueOak-1.0.0 | 5 |
| MIT OR Apache-2.0 | 4 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| CC0-1.0 | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| Unlicense | 1 |
| FSL-1.1-Apache-2.0 | 1 |
| 0BSD | 1 |

Total: 669 packages.

| Package | Licence | Scope | Reached from |
| --- | --- | --- | --- |
| `@babel/code-frame@7.29.7` | MIT | prod | apps/web |
| `@babel/compat-data@7.29.7` | MIT | prod | apps/web |
| `@babel/core@7.29.7` | MIT | prod | apps/web |
| `@babel/generator@7.29.8` | MIT | prod | apps/web |
| `@babel/helper-compilation-targets@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-globals@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-module-imports@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-module-transforms@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-string-parser@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-validator-identifier@7.29.7` | MIT | prod | apps/web |
| `@babel/helper-validator-option@7.29.7` | MIT | prod | apps/web |
| `@babel/helpers@7.29.10` | MIT | prod | apps/web |
| `@babel/parser@7.29.9` | MIT | prod | apps/web |
| `@babel/template@7.29.7` | MIT | prod | apps/web |
| `@babel/traverse@7.29.10` | MIT | prod | apps/web |
| `@babel/types@7.29.8` | MIT | prod | apps/web |
| `@clack/core@1.4.3` | MIT | dev | (root) |
| `@clack/prompts@1.7.0` | MIT | dev | (root) |
| `@cloudflare/kv-asset-handler@0.5.0` | MIT OR Apache-2.0 | prod | apps/web |
| `@cloudflare/unenv-preset@2.16.2` | MIT OR Apache-2.0 | prod | apps/web |
| `@cloudflare/vite-plugin@1.64.0` | MIT | dev | apps/web |
| `@cloudflare/workerd-darwin-64@1.20261012.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-darwin-64@1.20261019.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-darwin-arm64@1.20261012.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-darwin-arm64@1.20261019.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-linux-64@1.20261012.1` | Apache-2.0 | prod | apps/web |
| `@cloudflare/workerd-linux-64@1.20261019.1` | Apache-2.0 | prod | apps/web |
| `@cloudflare/workerd-linux-arm64@1.20261012.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-linux-arm64@1.20261019.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-windows-64@1.20261012.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cloudflare/workerd-windows-64@1.20261019.1` | Apache-2.0 ¹ | prod | apps/web |
| `@cspotcode/source-map-support@0.8.1` | MIT | prod | apps/web |
| `@drizzle-team/brocli@0.10.2` | Apache-2.0 | dev | apps/web |
| `@emnapi/core@1.11.3` | MIT ² | prod | apps/web |
| `@emnapi/core@1.4.5` | MIT | dev | (root) |
| `@emnapi/runtime@1.11.3` | MIT ² | prod | apps/web |
| `@emnapi/runtime@1.4.5` | MIT | dev | (root) |
| `@emnapi/wasi-threads@1.0.4` | MIT | dev | (root) |
| `@emnapi/wasi-threads@1.2.3` | MIT ² | prod | apps/web |
| `@esbuild-kit/core-utils@3.3.2` | MIT | dev | apps/web |
| `@esbuild-kit/esm-loader@2.6.5` | MIT | dev | apps/web |
| `@esbuild/aix-ppc64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/aix-ppc64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/android-arm64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/android-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/android-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/android-arm@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/android-arm@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/android-arm@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/android-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/android-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/android-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/darwin-arm64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/darwin-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/darwin-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/darwin-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/darwin-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/darwin-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/freebsd-arm64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/freebsd-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/freebsd-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/freebsd-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/freebsd-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/freebsd-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-arm64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-arm@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-arm@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-arm@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-ia32@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-ia32@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-ia32@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-loong64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-loong64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-loong64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-mips64el@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-mips64el@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-mips64el@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-ppc64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-ppc64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-ppc64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-riscv64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-riscv64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-riscv64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-s390x@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-s390x@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-s390x@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/linux-x64@0.18.20` | MIT | dev | apps/web |
| `@esbuild/linux-x64@0.25.12` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/linux-x64@0.28.2` | MIT | dev | apps/web |
| `@esbuild/netbsd-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/netbsd-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/netbsd-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/netbsd-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/netbsd-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/openbsd-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/openbsd-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/openbsd-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/openbsd-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/openbsd-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/openharmony-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/openharmony-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/sunos-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/sunos-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/sunos-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-arm64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-arm64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/win32-arm64@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-ia32@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-ia32@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/win32-ia32@0.28.2` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-x64@0.18.20` | MIT ¹ | dev | apps/web |
| `@esbuild/win32-x64@0.25.12` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@esbuild/win32-x64@0.28.2` | MIT ¹ | dev | apps/web |
| `@hackcove/theme-catppuccin-mocha@0.2.8` | MIT | prod | apps/web |
| `@hackcove/ui@0.4.4` | MIT | prod | apps/web |
| `@hono/node-server@2.1.5` | MIT | prod | packages/cli |
| `@img/colour@1.1.0` | MIT | prod | apps/web |
| `@img/sharp-darwin-arm64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-darwin-x64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-freebsd-wasm32@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-libvips-darwin-arm64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-darwin-x64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-arm64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-arm@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-ppc64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-riscv64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-s390x@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linux-x64@1.3.4` | LGPL-3.0-or-later | prod | apps/web |
| `@img/sharp-libvips-linuxmusl-arm64@1.3.4` | LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-libvips-linuxmusl-x64@1.3.4` | LGPL-3.0-or-later | prod | apps/web |
| `@img/sharp-linux-arm64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linux-arm@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linux-ppc64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linux-riscv64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linux-s390x@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linux-x64@0.35.5` | Apache-2.0 | prod | apps/web |
| `@img/sharp-linuxmusl-arm64@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-linuxmusl-x64@0.35.5` | Apache-2.0 | prod | apps/web |
| `@img/sharp-wasm32@0.35.5` | Apache-2.0 AND LGPL-3.0-or-later AND MIT ² | prod | apps/web |
| `@img/sharp-webcontainers-wasm32@0.35.5` | Apache-2.0 ¹ | prod | apps/web |
| `@img/sharp-win32-arm64@0.35.5` | Apache-2.0 AND LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-win32-ia32@0.35.5` | Apache-2.0 AND LGPL-3.0-or-later ¹ | prod | apps/web |
| `@img/sharp-win32-x64@0.35.5` | Apache-2.0 AND LGPL-3.0-or-later ¹ | prod | apps/web |
| `@internationalized/date@3.12.4` | Apache-2.0 | prod | apps/web |
| `@internationalized/number@3.6.9` | Apache-2.0 | prod | apps/web |
| `@internationalized/string@3.2.10` | Apache-2.0 | prod | apps/web |
| `@jest/diff-sequences@30.0.1` | MIT | dev | (root) |
| `@jridgewell/gen-mapping@0.3.13` | MIT | prod | apps/web |
| `@jridgewell/remapping@2.3.5` | MIT | prod | apps/web |
| `@jridgewell/resolve-uri@3.1.2` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@jridgewell/sourcemap-codec@1.6.0` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@jridgewell/trace-mapping@0.3.31` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@jridgewell/trace-mapping@0.3.9` | MIT | prod | apps/web |
| `@modelcontextprotocol/sdk@1.32.1` | MIT | prod | packages/cli |
| `@napi-rs/wasm-runtime@0.2.4` | MIT | dev | (root) |
| `@napi-rs/wasm-runtime@1.2.5` | MIT ² | prod | apps/web |
| `@nx/devkit@23.3.0` | MIT | dev | (root) |
| `@nx/dotnet@23.3.0` | MIT | dev | (root) |
| `@nx/nx-darwin-arm64@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-darwin-x64@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-freebsd-x64@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-linux-arm-gnueabihf@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-linux-arm64-gnu@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-linux-arm64-musl@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-linux-x64-gnu@23.3.0` | MIT | dev | (root) |
| `@nx/nx-linux-x64-musl@23.3.0` | MIT | dev | (root) |
| `@nx/nx-win32-arm64-msvc@23.3.0` | MIT ¹ | dev | (root) |
| `@nx/nx-win32-x64-msvc@23.3.0` | MIT ¹ | dev | (root) |
| `@oozcitak/dom@2.0.2` | MIT | prod | apps/web |
| `@oozcitak/infra@2.0.2` | MIT | prod | apps/web |
| `@oozcitak/url@3.0.0` | MIT | prod | apps/web |
| `@oozcitak/util@10.0.0` | MIT | prod | apps/web |
| `@opentelemetry/api@1.10.0` | Apache-2.0 | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@oxc-parser/binding-android-arm-eabi@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-android-arm64@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-darwin-arm64@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-darwin-x64@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-freebsd-x64@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-arm-gnueabihf@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-arm-musleabihf@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-arm64-gnu@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-arm64-musl@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-ppc64-gnu@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-riscv64-gnu@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-riscv64-musl@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-s390x-gnu@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-linux-x64-gnu@0.152.0` | MIT | prod | packages/cli |
| `@oxc-parser/binding-linux-x64-musl@0.152.0` | MIT | prod | packages/cli |
| `@oxc-parser/binding-openharmony-arm64@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-win32-arm64-msvc@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-win32-ia32-msvc@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-parser/binding-win32-x64-msvc@0.152.0` | MIT ¹ | prod | packages/cli |
| `@oxc-project/types@0.152.0` | MIT | prod | packages/cli |
| `@oxc-project/types@0.154.0` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@oxfmt/binding-android-arm-eabi@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-android-arm64@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-darwin-arm64@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-darwin-x64@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-freebsd-x64@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-arm-gnueabihf@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-arm-musleabihf@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-arm64-gnu@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-arm64-musl@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-ppc64-gnu@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-riscv64-gnu@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-riscv64-musl@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-s390x-gnu@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-linux-x64-gnu@0.74.0` | MIT | dev | (root) |
| `@oxfmt/binding-linux-x64-musl@0.74.0` | MIT | dev | (root) |
| `@oxfmt/binding-openharmony-arm64@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-win32-arm64-msvc@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-win32-ia32-msvc@0.74.0` | MIT ¹ | dev | (root) |
| `@oxfmt/binding-win32-x64-msvc@0.74.0` | MIT ¹ | dev | (root) |
| `@oxlint-tsgolint/darwin-arm64@7.0.2004` | MIT ¹ | dev | (root) |
| `@oxlint-tsgolint/darwin-x64@7.0.2004` | MIT ¹ | dev | (root) |
| `@oxlint-tsgolint/linux-arm64@7.0.2004` | MIT ¹ | dev | (root) |
| `@oxlint-tsgolint/linux-x64@7.0.2004` | MIT | dev | (root) |
| `@oxlint-tsgolint/win32-arm64@7.0.2004` | MIT ¹ | dev | (root) |
| `@oxlint-tsgolint/win32-x64@7.0.2004` | MIT ¹ | dev | (root) |
| `@oxlint/binding-android-arm-eabi@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-android-arm64@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-darwin-arm64@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-darwin-x64@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-freebsd-x64@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-arm-gnueabihf@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-arm-musleabihf@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-arm64-gnu@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-arm64-musl@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-ppc64-gnu@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-riscv64-gnu@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-riscv64-musl@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-s390x-gnu@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-linux-x64-gnu@1.89.0` | MIT | dev | (root) |
| `@oxlint/binding-linux-x64-musl@1.89.0` | MIT | dev | (root) |
| `@oxlint/binding-openharmony-arm64@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-win32-arm64-msvc@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-win32-ia32-msvc@1.89.0` | MIT ¹ | dev | (root) |
| `@oxlint/binding-win32-x64-msvc@1.89.0` | MIT ¹ | dev | (root) |
| `@playwright/test@1.60.0` | Apache-2.0 | dev | apps/web, packages/playwright |
| `@poppinss/colors@4.1.6` | MIT | prod | apps/web |
| `@poppinss/dumper@0.6.5` | MIT | prod | apps/web |
| `@poppinss/exception@1.2.3` | MIT | prod | apps/web |
| `@react-types/shared@3.37.0` | Apache-2.0 | prod | apps/web |
| `@rolldown/binding-android-arm-eabi@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-android-arm64@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-darwin-arm64@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-darwin-x64@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-freebsd-x64@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-arm-gnueabihf@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-arm64-gnu@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-arm64-musl@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-ppc64-gnu@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-s390x-gnu@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-x64-gnu@1.2.14` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-linux-x64-musl@1.2.14` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-openharmony-arm64@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-win32-arm64-msvc@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/binding-win32-x64-msvc@1.2.14` | MIT ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@rolldown/pluginutils@1.0.1` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `@sentry/browser-utils@11.9.0` | MIT | prod | apps/web |
| `@sentry/browser@11.9.0` | MIT | prod | apps/web |
| `@sentry/bun@11.9.0` | MIT | prod | packages/cli |
| `@sentry/bundler-plugins@11.9.0` | MIT | prod | packages/cli |
| `@sentry/cloudflare@11.9.0` | MIT | prod | apps/web |
| `@sentry/conventions@0.27.0` | MIT | prod | apps/web, packages/cli |
| `@sentry/core@11.9.0` | MIT | prod | apps/web, packages/cli |
| `@sentry/feedback@11.9.0` | MIT | prod | apps/web |
| `@sentry/node@11.9.0` | MIT | prod | packages/cli |
| `@sentry/opentelemetry@11.9.0` | MIT | prod | apps/web, packages/cli |
| `@sentry/react@11.9.0` | MIT | prod | apps/web |
| `@sentry/replay-canvas@11.9.0` | MIT | prod | apps/web |
| `@sentry/replay@11.9.0` | MIT | prod | apps/web |
| `@sentry/server-runtime-injection@11.9.0` | MIT | prod | packages/cli |
| `@sentry/server-utils@11.9.0` | MIT | prod | apps/web, packages/cli |
| `@sindresorhus/is@7.2.0` | MIT | prod | apps/web |
| `@speed-highlight/core@1.2.24` | CC0-1.0 | prod | apps/web |
| `@swc/helpers@0.5.23` | Apache-2.0 | prod | apps/web |
| `@tailwindcss/node@4.3.3` | MIT | prod | apps/web |
| `@tailwindcss/oxide-android-arm64@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-darwin-arm64@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-darwin-x64@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-freebsd-x64@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-linux-arm-gnueabihf@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-linux-arm64-gnu@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-linux-arm64-musl@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-linux-x64-gnu@4.3.3` | MIT | prod | apps/web |
| `@tailwindcss/oxide-linux-x64-musl@4.3.3` | MIT | prod | apps/web |
| `@tailwindcss/oxide-wasm32-wasi@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-win32-arm64-msvc@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide-win32-x64-msvc@4.3.3` | MIT ¹ | prod | apps/web |
| `@tailwindcss/oxide@4.3.3` | MIT | prod | apps/web |
| `@tailwindcss/vite@4.3.3` | MIT | prod | apps/web |
| `@tanstack/history@1.162.5` | MIT | prod | apps/web |
| `@tanstack/react-router@1.170.45` | MIT | prod | apps/web |
| `@tanstack/react-start-client@1.168.43` | MIT | prod | apps/web |
| `@tanstack/react-start-rsc@0.1.64` | MIT | prod | apps/web |
| `@tanstack/react-start-server@1.167.51` | MIT | prod | apps/web |
| `@tanstack/react-start@1.169.3` | MIT | prod | apps/web |
| `@tanstack/react-store@0.11.2` | MIT | prod | apps/web |
| `@tanstack/router-cli@1.167.45` | MIT | dev | apps/web |
| `@tanstack/router-core@1.171.38` | MIT | prod | apps/web |
| `@tanstack/router-generator@1.167.45` | MIT | prod | apps/web |
| `@tanstack/router-plugin@1.168.47` | MIT | prod | apps/web |
| `@tanstack/router-utils@1.162.4` | MIT | prod | apps/web |
| `@tanstack/start-client-core@1.170.38` | MIT | prod | apps/web |
| `@tanstack/start-fn-stubs@1.162.0` | MIT | prod | apps/web |
| `@tanstack/start-plugin-core@1.171.54` | MIT | prod | apps/web |
| `@tanstack/start-server-core@1.169.44` | MIT | prod | apps/web |
| `@tanstack/start-storage-context@1.167.40` | MIT | prod | apps/web |
| `@tanstack/store@0.11.2` | MIT | prod | apps/web |
| `@tanstack/virtual-file-routes@1.162.0` | MIT | prod | apps/web |
| `@tybys/wasm-util@0.10.4` | MIT ² | prod | apps/web |
| `@tybys/wasm-util@0.9.0` | MIT | dev | (root) |
| `@types/bun@1.4.3` | MIT | dev | (root), bench, packages/cli, packages/engine, packages/playwright |
| `@types/chai@5.2.3` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `@types/deep-eql@4.0.2` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `@types/estree@1.0.9` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `@types/node@26.6.5` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine, packages/playwright |
| `@types/pngjs@6.0.5` | MIT | dev | (root), bench, packages/cli, packages/engine, packages/playwright |
| `@types/react-dom@19.3.0` | MIT | prod | apps/web |
| `@types/react@19.3.0` | MIT | prod | apps/web |
| `@typescript/typescript-aix-ppc64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-darwin-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-darwin-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-freebsd-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-freebsd-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-arm@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-loong64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-mips64el@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-ppc64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-riscv64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-s390x@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-linux-x64@7.0.2` | Apache-2.0 | dev | (root) |
| `@typescript/typescript-netbsd-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-netbsd-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-openbsd-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-openbsd-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-sunos-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-win32-arm64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@typescript/typescript-win32-x64@7.0.2` | Apache-2.0 ¹ | dev | (root) |
| `@vitejs/plugin-react@6.1.2` | MIT | dev | apps/web |
| `@vitest/mocker@5.0.5` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `@vitest/spy@5.0.5` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `@yarnpkg/lockfile@1.1.0` | BSD-2-Clause | dev | (root) |
| `@zkochan/js-yaml@0.0.7` | MIT | dev | (root) |
| `accepts@2.0.0` | MIT | prod | packages/cli |
| `ajv-formats@3.0.1` | MIT | prod | packages/cli |
| `ajv@8.20.0` | MIT | prod | packages/cli |
| `ansi-regex@5.0.1` | MIT | dev | (root) |
| `ansi-styles@4.3.0` | MIT | dev | (root) |
| `ansis@4.4.0` | ISC | prod | apps/web |
| `argparse@2.0.1` | Python-2.0 | prod | (root), apps/web |
| `aria-hidden@1.2.6` | MIT | prod | apps/web |
| `assertion-error@2.0.1` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `babel-dead-code-elimination@1.0.12` | MIT | prod | apps/web |
| `balanced-match@4.0.3` | MIT | prod | (root), packages/cli |
| `base64-js@1.5.1` | MIT | dev | (root) |
| `baseline-browser-mapping@2.11.30` | Apache-2.0 | prod | apps/web |
| `bl@4.1.0` | MIT | dev | (root) |
| `blake3-wasm@2.1.5` | MIT | prod | apps/web |
| `body-parser@2.4.0` | MIT | prod | packages/cli |
| `brace-expansion@5.0.12` | MIT | prod | (root), packages/cli |
| `browserslist@4.29.4` | MIT | prod | apps/web |
| `buffer-from@1.1.2` | MIT | dev | apps/web |
| `buffer@5.7.1` | MIT | dev | (root) |
| `bun-types@1.4.3` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine, packages/playwright |
| `bundle-name@4.1.0` | MIT | dev | (root) |
| `bytes@3.1.2` | MIT | prod | packages/cli |
| `cac@7.1.0` | MIT | dev | apps/web |
| `call-bind-apply-helpers@1.0.2` | MIT | prod | packages/cli |
| `call-bound@1.0.4` | MIT | prod | packages/cli |
| `caniuse-lite@1.0.30001816` | CC-BY-4.0 | prod | apps/web |
| `chai@6.3.0` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `chalk@4.1.2` | MIT | dev | (root) |
| `chokidar@5.0.0` | MIT | prod | apps/web |
| `cli-cursor@3.1.0` | MIT | dev | (root) |
| `cli-spinners@2.6.1` | MIT | dev | (root) |
| `client-only@0.0.1` | MIT | prod | apps/web |
| `cliui@8.0.1` | ISC | dev | (root) |
| `clone@1.0.4` | MIT | dev | (root) |
| `clsx@2.1.1` | MIT | prod | apps/web |
| `color-convert@2.0.1` | MIT | dev | (root) |
| `color-name@1.1.4` | MIT | dev | (root) |
| `content-disposition@2.0.1` | MIT | prod | packages/cli |
| `content-type@1.0.5` | MIT | prod | packages/cli |
| `content-type@2.1.0` | MIT | prod | packages/cli |
| `convert-source-map@2.0.0` | MIT | prod | apps/web |
| `cookie-es@3.1.1` | MIT | prod | apps/web |
| `cookie-signature@1.2.2` | MIT | prod | packages/cli |
| `cookie@0.7.2` | MIT | prod | packages/cli |
| `cookie@1.1.1` | MIT | prod | apps/web |
| `cors@2.8.6` | MIT | prod | packages/cli |
| `cross-spawn@7.0.6` | MIT | prod | packages/cli |
| `csstype@3.2.3` | MIT | prod | apps/web |
| `debug@4.4.3` | MIT | prod | apps/web, packages/cli |
| `default-browser-id@5.0.0` | MIT | dev | (root) |
| `default-browser@5.2.1` | MIT | dev | (root) |
| `defaults@1.0.4` | MIT | dev | (root) |
| `define-lazy-prop@3.0.0` | MIT | dev | (root) |
| `depd@2.0.0` | MIT | prod | packages/cli |
| `detect-libc@2.1.2` | Apache-2.0 | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `diff@9.0.0` | BSD-3-Clause | prod | apps/web |
| `dotenv-expand@12.0.3` | BSD-2-Clause | dev | (root) |
| `dotenv@16.4.7` | BSD-2-Clause | dev | (root) |
| `dotenv@17.4.2` | BSD-2-Clause | prod | packages/cli |
| `drizzle-kit@0.31.11` | MIT | dev | apps/web |
| `drizzle-orm@0.45.4` | Apache-2.0 | prod | apps/web |
| `dunder-proto@1.0.1` | MIT | prod | packages/cli |
| `ee-first@1.1.1` | MIT | prod | packages/cli |
| `ejs@5.0.1` | Apache-2.0 | dev | (root) |
| `electron-to-chromium@1.5.459` | ISC | prod | apps/web |
| `emoji-regex@8.0.0` | MIT | dev | (root) |
| `encodeurl@2.0.0` | MIT | prod | packages/cli |
| `end-of-stream@1.4.5` | MIT | dev | (root) |
| `enhanced-resolve@5.26.0` | MIT | prod | apps/web |
| `error-stack-parser-es@1.0.5` | MIT | prod | apps/web |
| `es-define-property@1.0.1` | MIT | prod | packages/cli |
| `es-errors@1.3.0` | MIT | prod | packages/cli |
| `es-module-lexer@2.3.2` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `es-object-atoms@1.1.2` | MIT | prod | packages/cli |
| `esbuild@0.18.20` | MIT | dev | apps/web |
| `esbuild@0.25.12` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `esbuild@0.28.2` | MIT | dev | apps/web |
| `escalade@3.2.0` | MIT | prod | (root), apps/web |
| `escape-html@1.0.3` | MIT | prod | packages/cli |
| `escape-string-regexp@1.0.5` | MIT | dev | (root) |
| `estree-walker@3.0.3` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `etag@1.8.1` | MIT | prod | packages/cli |
| `eventsource-parser@3.1.1` | MIT | prod | packages/cli |
| `eventsource@3.0.7` | MIT | prod | packages/cli |
| `expect-type@1.4.0` | Apache-2.0 | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `express-rate-limit@8.7.1` | MIT | prod | packages/cli |
| `express@5.3.0` | MIT | prod | packages/cli |
| `exsolve@1.1.3` | MIT | prod | apps/web |
| `fast-deep-equal@3.1.3` | MIT | prod | packages/cli |
| `fast-string-truncated-width@3.0.3` | MIT | dev | (root) |
| `fast-string-width@3.0.2` | MIT | dev | (root) |
| `fast-uri@3.1.9` | BSD-3-Clause | prod | packages/cli |
| `fast-wrap-ansi@0.2.0` | MIT | dev | (root) |
| `fdir@6.5.0` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `fetchdts@0.2.0` | MIT | prod | apps/web |
| `figures@3.2.0` | MIT | dev | (root) |
| `finalhandler@2.1.1` | MIT | prod | packages/cli |
| `forwarded@0.2.0` | MIT | prod | packages/cli |
| `fresh@2.0.0` | MIT | prod | packages/cli |
| `fs-constants@1.0.0` | MIT | dev | (root) |
| `fsevents@2.3.2` | MIT ¹ | prod | apps/web, bench, packages/engine, packages/playwright |
| `fsevents@2.3.3` | MIT ¹ | dev | apps/web |
| `function-bind@1.1.2` | MIT | prod | packages/cli |
| `gensync@1.0.0-beta.2` | MIT | prod | apps/web |
| `get-caller-file@2.0.5` | ISC | dev | (root) |
| `get-intrinsic@1.3.0` | MIT | prod | packages/cli |
| `get-proto@1.0.1` | MIT | prod | packages/cli |
| `get-tsconfig@4.14.3` | MIT | dev | apps/web |
| `glob@13.0.6` | BlueOak-1.0.0 | prod | packages/cli |
| `gopd@1.2.0` | MIT | prod | packages/cli |
| `graceful-fs@4.2.11` | ISC | prod | apps/web |
| `has-flag@4.0.0` | MIT | prod | (root), apps/web, packages/cli |
| `has-symbols@1.1.0` | MIT | prod | packages/cli |
| `hasown@2.0.4` | MIT | prod | packages/cli |
| `hono@4.13.13` | MIT | prod | packages/cli |
| `http-errors@2.0.1` | MIT | prod | packages/cli |
| `iconv-lite@0.7.3` | MIT | prod | packages/cli |
| `ieee754@1.2.1` | BSD-3-Clause | dev | (root) |
| `ignore@7.0.6` | MIT | dev | (root) |
| `inherits@2.0.4` | ISC | prod | (root), packages/cli |
| `ip-address@10.7.4` | MIT | prod | packages/cli |
| `ipaddr.js@1.9.1` | MIT | prod | packages/cli |
| `is-docker@3.0.0` | MIT | dev | (root) |
| `is-fullwidth-code-point@3.0.0` | MIT | dev | (root) |
| `is-inside-container@1.0.0` | MIT | dev | (root) |
| `is-interactive@1.0.0` | MIT | dev | (root) |
| `is-promise@4.0.0` | MIT | prod | packages/cli |
| `is-unicode-supported@0.1.0` | MIT | dev | (root) |
| `is-wsl@3.1.0` | MIT | dev | (root) |
| `isbot@5.2.2` | Unlicense | prod | apps/web |
| `isexe@2.0.0` | ISC | prod | (root), packages/cli |
| `jiti@2.7.0` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `jose@6.2.13` | MIT | prod | packages/cli |
| `js-tokens@4.0.0` | MIT | prod | apps/web |
| `js-yaml@4.3.2` | MIT | prod | apps/web |
| `jsesc@3.1.0` | MIT | prod | apps/web |
| `json-schema-traverse@1.0.0` | MIT | prod | packages/cli |
| `json-schema-typed@8.0.2` | BSD-2-Clause | prod | packages/cli |
| `json5@2.2.3` | MIT | prod | (root), apps/web |
| `jsonc-parser@3.3.1` | MIT | dev | (root) |
| `kleur@4.1.5` | MIT | prod | apps/web |
| `lightningcss-android-arm64@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-android-arm64@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-darwin-arm64@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-darwin-arm64@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-darwin-x64@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-darwin-x64@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-freebsd-x64@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-freebsd-x64@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-linux-arm-gnueabihf@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-linux-arm-gnueabihf@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-linux-arm64-gnu@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-linux-arm64-gnu@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-linux-arm64-musl@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-linux-arm64-musl@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-linux-x64-gnu@1.32.0` | MPL-2.0 | prod | apps/web |
| `lightningcss-linux-x64-gnu@1.33.0` | MPL-2.0 | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-linux-x64-musl@1.32.0` | MPL-2.0 | prod | apps/web |
| `lightningcss-linux-x64-musl@1.33.0` | MPL-2.0 | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-win32-arm64-msvc@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-win32-arm64-msvc@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss-win32-x64-msvc@1.32.0` | MPL-2.0 ¹ | prod | apps/web |
| `lightningcss-win32-x64-msvc@1.33.0` | MPL-2.0 ¹ | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lightningcss@1.32.0` | MPL-2.0 | prod | apps/web |
| `lightningcss@1.33.0` | MPL-2.0 | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `lines-and-columns@2.0.3` | MIT | dev | (root) |
| `log-symbols@4.1.0` | MIT | dev | (root) |
| `lru-cache@11.5.3` | BlueOak-1.0.0 | prod | packages/cli |
| `lru-cache@5.1.1` | ISC | prod | apps/web |
| `magic-string@0.30.21` | MIT | prod | apps/web |
| `magic-string@1.4.3` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `math-intrinsics@1.1.0` | MIT | prod | packages/cli |
| `media-typer@1.1.1` | MIT | prod | packages/cli |
| `merge-descriptors@2.0.0` | MIT | prod | packages/cli |
| `mime-db@1.54.0` | MIT | prod | packages/cli |
| `mime-types@3.0.2` | MIT | prod | packages/cli |
| `mimic-fn@2.1.0` | MIT | dev | (root) |
| `miniflare@5.20261012.0-beta` | MIT | dev | apps/web |
| `miniflare@5.20261019.0-beta` | MIT | prod | apps/web |
| `minimatch@10.2.5` | BlueOak-1.0.0 | prod | (root), packages/cli |
| `minimist@1.2.8` | MIT | dev | (root) |
| `minipass@7.1.3` | BlueOak-1.0.0 | prod | packages/cli |
| `ms@2.1.3` | MIT | prod | apps/web, packages/cli |
| `nanoid@3.3.20` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `negotiator@1.1.0` | MIT | prod | packages/cli |
| `node-releases@2.0.59` | MIT | prod | apps/web |
| `npm-run-path@4.0.1` | MIT | dev | (root) |
| `nx@23.3.0` | MIT | dev | (root) |
| `object-assign@4.1.1` | MIT | prod | packages/cli |
| `object-inspect@1.13.4` | MIT | prod | packages/cli |
| `obug@3.0.0` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `on-finished@2.4.2` | MIT | prod | packages/cli |
| `once@1.4.0` | ISC | prod | (root), packages/cli |
| `onetime@5.1.2` | MIT | dev | (root) |
| `open@10.1.0` | MIT | dev | (root) |
| `ora@5.4.1` | MIT | dev | (root) |
| `oxc-parser@0.152.0` | MIT | prod | packages/cli |
| `oxfmt@0.74.0` | MIT | dev | (root) |
| `oxlint-tsgolint@7.0.2004` | MIT | dev | (root) |
| `oxlint@1.89.0` | MIT | dev | (root) |
| `parseurl@1.3.3` | MIT | prod | packages/cli |
| `path-key@3.1.1` | MIT | prod | (root), packages/cli |
| `path-scurry@2.0.2` | BlueOak-1.0.0 | prod | packages/cli |
| `path-to-regexp@6.3.0` | MIT | prod | apps/web |
| `path-to-regexp@8.4.2` | MIT | prod | packages/cli |
| `pathe@2.0.3` | MIT | prod | apps/web |
| `picocolors@1.1.1` | ISC | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `picomatch@4.0.7` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `pkce-challenge@5.0.1` | MIT | prod | packages/cli |
| `playwright-core@1.60.0` | Apache-2.0 | prod | apps/web, bench, packages/engine, packages/playwright |
| `playwright@1.60.0` | Apache-2.0 | prod | apps/web, bench, packages/engine, packages/playwright |
| `pngjs@7.0.0` | MIT | prod | (root), bench, packages/cli, packages/engine, packages/playwright |
| `postcss@8.5.31` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `prettier@3.9.10` | MIT | prod | apps/web |
| `proxy-addr@2.0.8` | MIT | prod | packages/cli |
| `qs@6.16.1` | BSD-3-Clause | prod | packages/cli |
| `range-parser@1.3.0` | MIT | prod | packages/cli |
| `raw-body@3.0.2` | MIT | prod | packages/cli |
| `react-aria-components@1.22.1` | Apache-2.0 | prod | apps/web |
| `react-aria@3.53.1` | Apache-2.0 | prod | apps/web |
| `react-dom@19.3.1` | MIT | prod | apps/web |
| `react-stately@3.51.0` | Apache-2.0 | prod | apps/web |
| `react@19.3.1` | MIT | prod | apps/web |
| `readable-stream@3.6.2` | MIT | dev | (root) |
| `readdirp@5.1.1` | MIT | prod | apps/web |
| `require-directory@2.1.1` | MIT | dev | (root) |
| `require-from-string@2.0.2` | MIT | prod | packages/cli |
| `resolve-pkg-maps@1.0.0` | MIT | dev | apps/web |
| `resolve.exports@2.0.3` | MIT | dev | (root) |
| `restore-cursor@3.1.0` | MIT | dev | (root) |
| `rolldown@1.2.14` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `router@2.2.0` | MIT | prod | packages/cli |
| `run-applescript@7.0.0` | MIT | dev | (root) |
| `safe-buffer@5.2.1` | MIT | dev | (root) |
| `safer-buffer@2.1.2` | MIT | prod | packages/cli |
| `scheduler@0.28.0` | MIT | prod | apps/web |
| `semver@6.3.1` | ISC | prod | apps/web |
| `semver@7.8.5` | ISC | prod | (root), apps/web |
| `send@1.2.1` | MIT | prod | packages/cli |
| `sentry@0.45.0` | FSL-1.1-Apache-2.0 | prod | packages/cli |
| `seroval-plugins@1.6.11` | MIT | prod | apps/web |
| `seroval@1.6.11` | MIT | prod | apps/web |
| `serve-static@2.2.1` | MIT | prod | packages/cli |
| `setprototypeof@1.2.0` | ISC | prod | packages/cli |
| `sharp@0.35.5` | Apache-2.0 | prod | apps/web |
| `shebang-command@2.0.0` | MIT | prod | packages/cli |
| `shebang-regex@3.0.0` | MIT | prod | packages/cli |
| `side-channel-list@1.0.1` | MIT | prod | packages/cli |
| `side-channel-map@1.0.1` | MIT | prod | packages/cli |
| `side-channel-weakmap@1.0.2` | MIT | prod | packages/cli |
| `side-channel@1.1.1` | MIT | prod | packages/cli |
| `signal-exit@3.0.7` | ISC | dev | (root) |
| `sisteransi@1.0.5` | MIT | dev | (root) |
| `smol-toml@1.9.0` | BSD-3-Clause | dev | (root) |
| `source-map-js@1.2.2` | BSD-3-Clause | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `source-map-support@0.5.21` | MIT | dev | apps/web |
| `source-map@0.6.1` | BSD-3-Clause | dev | apps/web |
| `source-map@0.7.6` | BSD-3-Clause | prod | apps/web |
| `srvx@1.0.6` | MIT | prod | apps/web |
| `statuses@2.0.2` | MIT | prod | packages/cli |
| `std-env@4.3.0` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `string-width@4.2.3` | MIT | dev | (root) |
| `string_decoder@1.3.0` | MIT | dev | (root) |
| `strip-ansi@6.0.1` | MIT | dev | (root) |
| `strip-bom@3.0.0` | MIT | dev | (root) |
| `supports-color@10.2.2` | MIT | prod | apps/web |
| `supports-color@7.2.0` | MIT | prod | (root), apps/web, packages/cli |
| `supports-color@8.1.1` | MIT | prod | packages/cli |
| `tailwindcss@4.3.3` | MIT | prod | apps/web |
| `tapable@2.3.3` | MIT | prod | apps/web |
| `tar-stream@2.2.0` | MIT | dev | (root) |
| `tinybench@6.2.2` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `tinyexec@1.3.1` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `tinyglobby@0.2.17` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `tinypool@2.2.0` | MIT | dev | (root) |
| `tmp@0.2.7` | MIT | dev | (root) |
| `toidentifier@1.0.1` | MIT | prod | packages/cli |
| `tsconfig-paths@4.2.0` | MIT | dev | (root) |
| `tslib@2.8.1` | 0BSD | prod | apps/web |
| `tsx@4.23.15` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `type-is@2.1.0` | MIT | prod | packages/cli |
| `typescript@7.0.2` | Apache-2.0 | dev | (root) |
| `ufo@1.6.4` | MIT | prod | apps/web |
| `undici-types@8.12.2` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine, packages/playwright |
| `undici-types@8.9.0` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine, packages/playwright |
| `undici@7.29.0` | MIT | dev | (root) |
| `undici@7.29.1` | MIT | dev | apps/web |
| `unenv@2.0.0-rc.24` | MIT | prod | apps/web |
| `unpipe@1.0.0` | MIT | prod | packages/cli |
| `unplugin@3.4.0` | MIT | prod | apps/web |
| `update-browserslist-db@1.3.4` | MIT | prod | apps/web |
| `use-sync-external-store@1.7.0` | MIT | prod | apps/web |
| `util-deprecate@1.0.2` | MIT | dev | (root) |
| `vary@1.1.2` | MIT | prod | packages/cli |
| `vite@8.3.4` | MIT | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `vitefu@1.1.3` | MIT | prod | apps/web |
| `vitest@5.0.5` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `wcwidth@1.0.1` | MIT | dev | (root) |
| `web-vitals@6.2.3` | Apache-2.0 | prod | apps/web |
| `webpack-virtual-modules@0.6.2` | MIT | prod | apps/web |
| `which@2.0.2` | ISC | prod | packages/cli |
| `which@3.0.1` | ISC | dev | (root) |
| `why-is-node-running@3.2.1` | MIT | dev | (root), apps/web, bench, packages/cli, packages/engine |
| `workerd@1.20261012.1` | Apache-2.0 | prod | apps/web |
| `workerd@1.20261019.1` | Apache-2.0 | prod | apps/web |
| `wrangler@4.151.0` | MIT OR Apache-2.0 | dev | apps/web |
| `wrangler@4.151.2` | MIT OR Apache-2.0 | prod | apps/web |
| `wrap-ansi@7.0.0` | MIT | dev | (root) |
| `wrappy@1.0.2` | ISC | prod | (root), packages/cli |
| `ws@8.21.0` | MIT | prod | apps/web |
| `xmlbuilder2@4.0.3` | MIT | prod | apps/web |
| `y18n@5.0.8` | ISC | dev | (root) |
| `yallist@3.1.1` | ISC | prod | apps/web |
| `yaml@2.9.0` | ISC | prod | (root), apps/web, bench, packages/cli, packages/engine |
| `yargs-parser@21.1.1` | ISC | dev | (root) |
| `yargs@17.7.2` | MIT | dev | (root) |
| `youch-core@0.3.3` | MIT | prod | apps/web |
| `youch@4.1.0-beta.10` | MIT | prod | apps/web |
| `zod-to-json-schema@3.25.2` | ISC | prod | packages/cli |
| `zod@4.6.7` | MIT | prod | apps/web, packages/cli |
