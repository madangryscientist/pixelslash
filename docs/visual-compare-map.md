---
label: wayfinder:map
title: Visual Compare — sellable DS reviewer
---

## Destination

**PixelSlash** — a product you can sell that reviews Main vs Branch (pixel dashboard) and a web page against a Figma design system: **local CLI**, then a **CI Action** wrapping that CLI, then **SaaS** hosting the same engine. One engine, three skins. Not Chromatic. Not `ob`. Not Cue. Not a new dashboard unit.

First dogfood: **Omnishell GTK shots** on `/pixelslash` (ob 763). A URL or PNG pair may omit a design system (ob 888, landed; dogfood run `mucuyo6a` on `/pixelslash`). **Figma dogfood is out of scope** (decision #62, 2026-09-22). Do not reopen 770, 771, 772, 781, 782, 773, or 783 to draw or drive Figma.

## Notes

- Parent ticket: [Visual Compare: Figma + live site + new version, plus AI/tracker confidence](ob://649). Grilled 2026-09-13; readback confirmed.
- Domain: Nx app `apps/pixelslash` in omnibus until extract (renamed from `apps/visual-compare`, ob 763). Skills: this map, `planner`, `skeptical-review`.
- Seed DS: `@omnibus/ui` + Catppuccin Mocha (`platform/ui`). hack-cove already consumes it. After [HITL: create the Figma DS file from @omnibus/ui](ob://651), **Figma is the spec**.
- `ob vision compare` (ob 468) stays a two-screenshot layout tool. This product does not reuse that CLI as the product; it may reuse the local mlx spawn pattern.
- `apps/visual-gate` was the leftover Chromatic app. Removed (ob 915). PixelSlash is the capture-and-judge engine.

## Decisions so far

- **Job:** CodeRabbit-shaped DS reviewer (findings + confidence). Not a Chromatic land gate. Human still lands.
- **Customer zero:** a site in this repo. Cue is out (decision #54).
- **Packaging:** all three (local, CI, SaaS). **v1 = local CLI.** CI wraps it later. SaaS hosts it last.
- **Compare:** component match, vision-first. One run = one page (live URL + localhost) vs the whole Figma DS. mlx sees page shots + Figma component rasters. No DOM contract.
- **Live vs local:** debt vs regression. Same DS check on both. Report prod violations vs **new** violations the change introduced. Exit 1 on new violations (CI-ready); not hooked to omnibus land.
- **Capture:** product-driven Playwright against the URLs you pass. Does not start `nx dev`. Down URL → fail.
- **Judge:** local mlx. Page screenshots never leave. Figma API is the only egress (after the fixture slice).
- **v1 does not score ticket ACs.** ob paragraph is a stub. AC confidence is v2.
- **Output:** terminal summary + local HTML. ob ticket paragraph is omnibus dogfood glue, not the product.
- **Figma IDs:** CLI flags every run. Token via `ob secret` (HITL), never git.
- **Repo:** prototype in omnibus. Extract when one hack-cove page actually judges. Do not sell `ob`.
- **Source of truth:** seed Figma from `@omnibus/ui` once (you in the UI). After that, Figma wins; implementation fails.
- **First slice:** engine on fixture rasters + fixture pages. Real Figma file in parallel (HITL).
- **Default page width:** 1280, flag to override. (Page-frame viewport decision vacated — there is no page mock.)
- **Replaces** [Local visual gate: Chromatic-like, runs only on this machine](ob://574). Close 574 when this map charts. `apps/visual-gate` was removed (ob 915).
- Numbered as **decision #55** (2026-09-13). **Amended by decision #58** (2026-09-18, ob 763): product name PixelSlash; Omnishell pixel-dashboard is this skin (`/pixelslash` on the existing dashboard, files on disk, DS judge optional). **Amended by decision #62** (2026-09-22, ob 911): Figma dogfood is out of scope. Pixel path is a URL or PNG pair with no design system.

## Not yet specified

- First real hack-cove `/` run (live hack-cove.com + local preview). Token via `ob secret` is a later ticket, not 657.
- Extract to a product repo (the moment one page judges).
- Omnibus-only `ob note` stub after a run.
- v2: ticket AC confidence (same run or second command).
- CI Action skin. SaaS. Jira adapter. GitHub review comments. Component-subset flags. Mobile as a second run. DOM heuristics. Capture automation (grim by hand until then).

## Out of scope

- Cue app / cue-designs / Linear ingest. Decision #54.
- Chromatic cloud, Percy, uploading shots.
- Replacing `ob vision compare`.
- Starting the user's dev server / taking port leases for `nx dev`.
- Auto-landing on a score. Rewriting `@omnibus/ui` from Figma in v1.
- Figma dogfood: drawing specs, driving Figma, grim-vs-Figma zero, and the Figma column on Omnishell or the dashboard (770, 771, 772, 781, 782, 773, 783). Closed 2026-09-22. Decision #62.

## Frontier (ob)

- [Visual Compare v1: fixture engine (Playwright + mlx + HTML, no Figma)](ob://650) — done.
- [Visual Compare: engine test suite beyond the 650 prove cases](ob://655) — done.
- [HITL: create the Figma DS file from @omnibus/ui](ob://651) — done. File key `dT3GXFF5uVHQtmn12XgWEI`.
- [Visual Compare: swap fixture DS for Figma API rasters](ob://657) — listed. `--file FILE_KEY`, mock HTTP; `--ds` stays.
- [Visual Compare: Chromatic-like dashboard (branch vs main)](ob://669) — done. Same engine; HTML is Main/Branch (counts, shots, rasters, new-on-branch). Not pixel cloud, not auto-land.
- [Visual Compare: also use for regression testing](ob://653) — later. Multi-route index.
- [PixelSlash: usable dashboard of changes (rename visual-compare)](ob://763) — done.
- [PixelSlash URL compare without a design system](ob://888) — done. Dogfood pushed `/pixelslash/mucuyo6a-df8b5ebc`.
- Figma tickets 770, 771, 772, 781, 782, 773, 783 — closed, out of scope. Do not reopen.
- Parent [Visual Compare](ob://649) — stays open for the pixel product, not for a Figma column.
