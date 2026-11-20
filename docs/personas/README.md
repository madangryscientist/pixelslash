# Personas

These are the five kinds of people PixelSlash is built for. Use them to say who a change is for: a
ticket, a doc or a design review can name one of them and say what that person gains or loses. The
personas are read from what the product does today, not from what we hope it will do. Where a
persona needs something that is not built yet, it is marked as a gap at the end.

## At a glance

The table is generated from [`personas.json`](personas.json), which is the source. Each persona
says what they look for in the hosted review app (`review`), on pixelslash.dev and its docs
(`docs`) and in the CLI (`cli`).

<!-- personas:start -->
| Persona | Group | Model | Who | Looks for (review) | Looks for (docs) | Looks for (cli) |
| --- | --- | --- | --- | --- | --- | --- |
| Priya | Product team | sonnet | Frontend lead of six engineers on one React app with a half kept up Storybook, on Chromatic today. She uploads each build from GitHub Actions and accepts or rejects each change on the build page; her goal is that every pull request shows what changed visually and nothing merges until someone has looked. | One click from the pull request to the change, never two clicks to review. | An answer to why a baseline moved, so baselines never drift without anyone knowing why. | Few false alarms, with anti-aliasing and font hinting absorbed, so not every pull request shows a red X. |
| Marcus | Platform or monorepo | opus | Platform engineer on a monorepo of about twenty packages (a design system, three apps and the docs) built under a task runner whose cache skips unchanged packages. His goal is one visual check per pull request across every package, without spending CI minutes on packages that did not change. | Twenty subprojects with one change each shown as twenty changes in one place, not as twenty checks on the pull request. | A setup that fits the task runner he already has, without each package needing its own configuration. | A package the cache skipped never leaves a required check waiting forever. |
| Lena | Product team | sonnet | Design-system maintainer who owns the component library and its tokens, which product teams consume, so one change ripples into every app. Her goal is to catch a token or spacing regression before a consumer ships it, and to know which stories the change touched. | A diff measured at the level of a region that comes with a note, and a way to accept a library-wide change in one step. | How to keep an intended change from producing noise on every story. | A violation flagged without a screenshot leaving her machine. |
| Tomás | Privacy-bound | opus | Engineer at a fintech or health company whose screenshots can show data that looks like customer data, where nothing leaves the network without security sign-off. His goal is visual review with every screenshot kept in-house, self-hosted with Docker or on a box inside the LAN. | A self-hosted app with all of the hosted features, and no feature that works only on the hosted app. | Every outbound call listed and off by default, and a data flow written down that says plainly where data goes. | No SaaS call that is required to run it. |
| Sam | Solo or agency | sonnet | Solo developer or small agency building client sites, often without Storybook, sometimes with Playwright tests and sometimes with only a URL. Sam wants to know in a minute whether a CSS change broke the other pages. | A report that never claims more than it measured. | No sign-up wall and no heavy configuration between Sam and the first answer. | No setup, no account and no Storybook, and exit codes that CI can read. |
<!-- personas:end -->

## Edit, add or remove

Edit `personas.json`, then run `bun scripts/personas.ts` from the repository root to rewrite the
table above. `bun scripts/personas.ts --check` fails when the file is invalid or the table is
stale, and the gate runs it. There are always exactly five personas, an odd number, so a vote
between them always has a winner: to add one, remove one. Each persona needs a lower-case kebab
`id`, a `name`, a `group` from `groups`, a `model` from `models`, a `profile`, and one `focus`
line for each of `review`, `docs` and `cli`. No field the table prints may hold a `|` or a line
break.

## 1. Priya, frontend lead on a product team

Priya leads six engineers on one React app. The app has a Storybook that is half kept up, and she
is on Chromatic today. Her goal is that every pull request shows what
changed visually, and that nothing merges until someone has looked.

She uses the CLI in GitHub Actions to upload each build to the hosted app. A PixelSlash commit
status stays pending on the pull request until the changes are approved, and a comment on the pull
request links to the build. On the build page she accepts or rejects each change.

She wins when the path from the pull request to the change is one click, when the tool raises few
false alarms because anti-aliasing and font hinting are absorbed. She loses when every pull request shows a red X, when reviewing takes two clicks,
or when baselines drift and nobody knows why.

## 2. Marcus, platform engineer in a monorepo

Marcus runs a monorepo of about twenty packages: a design system, three apps and the docs. The
packages build under a task runner (moon, Nx or Turbo) whose cache skips the packages that did not
change. His goal is one visual check per pull request across every package, without spending CI
minutes on packages that did not change.

He uses subprojects: each package is one subproject with its own builds and its own review. The
project posts one commit status on the pull request that covers every subproject; a subproject posts
none of its own. A subproject that the task runner skipped does not hold that status open.
`pixelslash upload --skipped` posts a passed build with no shots for a package the cache skipped, so
that package does not look like missing work. It captures nothing, so a commit where the cache skipped
every capture still gets a green status. A combined review across subprojects is
planned and not built yet.

He wins when twenty subprojects with one change each show as twenty changes in one place, and when
the setup fits the task runner he already has. He loses when a pull request shows twenty checks, when
a required check waits forever for a package that was skipped, or when each package needs its own
configuration.

## 3. Lena, design-system maintainer

Lena owns the component library and its tokens. Product teams consume the library, so one change
ripples into every app that uses it. Her goal is to catch a token or spacing regression before a
consumer ships it, and to know which stories the change touched.

She captures every story in light and dark, from Storybook or from Playwright. The design-system
judge can run with a local vision model, so a violation is flagged without any shot leaving her
machine. Twins across themes and viewports show the same component in each setting side by side.

She wins when a diff is measured at the level of a region and comes with a note, and when a
violation is flagged without a shot leaving the machine. She loses when an intended change
produces noise on every story, and when there is no way to accept a library-wide change in one step.

## 4. Tomás, privacy-bound engineer at a regulated company

Tomás works at a fintech or a health company. The shots of his product can show data that
looks like customer data, and nothing leaves the company network without security sign-off. His goal
is visual review with every shot kept in-house.

He self-hosts PixelSlash, with Docker or on a box inside the LAN, and keeps the storage under his
own control. The CLI runs local unless it is told to upload. An AI model, when a project names one,
receives only the crops of the regions that changed, never a whole shot, and it is opt-in per
project. Error reports are scrubbed before they leave, and the repository's `SECURITY.md` documents
the data flow.

He wins when every outbound call is listed and off by default, when the data flow is written down,
and when self-hosting gives him all of the hosted features. He loses when a SaaS call is required,
when the answer about where data goes is vague, or when a feature works only on the hosted app.

## 5. Sam, solo developer or small agency

Sam builds client sites, often without Storybook. Sometimes there are Playwright tests, and
sometimes there is only a URL. The question Sam wants answered is "did my CSS change break the other
pages?", and wants the answer in a minute.

Sam uses the CLI's pair mode: `--live` against `--local`, or two PNG files. The report, `report.html`,
opens locally in a browser. The Playwright helper takes the shots for an existing test suite. A
Vitest plugin is being explored.

Sam wins with no setup, no account, no Storybook, and exit codes that CI can read. Sam loses at a
sign-up wall, a heavy configuration, or a report that claims more than it measured.

## What they point at

These are the open gaps, the places where a persona still has to work around the product:

- **Priya's one click** needs the App's commit status permission granted on each install. Where that
  permission is missing, the pull request shows no status to click.
- **Marcus** needs the subproject web pages and the combined review across subprojects. Until the
  combined review exists, twenty subprojects are twenty pages to visit.
- **Lena** has no bulk accept. Every change is accepted one at a time, so an intended library-wide
  change has no single step.
- **Sam** waits on the Vitest plugin. Until it exists, a Vitest suite needs the CLI or the Playwright
  helper.
