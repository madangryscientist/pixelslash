# Competitor pricing and limits

Feeds the pricing round of Decide: positioning (ob 1426). Every figure was read
from a primary source (a vendor pricing page, vendor docs, a licence file or
the GitHub API) on **2026-10-19**, unless the row says otherwise. Where no
primary source could be found, the figure is marked **UNVERIFIED**; where the
vendor does not publish one, it says **not published**. Prices are list USD
before tax. No trials were started and no forms were submitted.

## Summary

- **Chromatic, Percy, Happo and Argos all charge for unchanged shots and count
  each browser and viewport as a separate shot.** (Applitools' multiplier is
  UNVERIFIED; for Argos it is implied by its docs rather than stated; Lost
  Pixel never published one; Meticulous priced per user.) Chromatic discounts
  TurboSnap-copied shots to 0.2 of a snapshot. That discount used to be free:
  it became billable in January 2024. Happo and Argos state that unchanged
  shots bill at full rate; for Percy that is inferred (no discount is
  published). Percy and Argos also bill failed captures (Argos
  contradicts itself on this, see below).
- **Chromatic is still tied to Storybook.** Even its Playwright and Cypress
  integrations build a Storybook archive.
- **Lost Pixel is gone.** Its team joined Figma on 2026-04-22 and the repo is
  archived. Argos (MIT) is the only live open-source tool with a hosted review
  UI, and it says self-hosting is "not officially supported or documented".
- **Prices vary roughly 9× to 20× at scale,** depending on whether Argos's
  Storybook rate and Percy's partly unverified overage are counted. At 200k
  shots a month the published prices run from about $350 (Argos, Storybook
  shots) through $700 (Happo), $760 (Argos), $1.5k (Chromatic) and $6.7k
  (Percy), to contact-sales (Applitools, Meticulous).

## Per vendor

### Chromatic

Sources: [pricing](https://www.chromatic.com/pricing),
[billing docs](https://www.chromatic.com/docs/billing/),
[TurboSnap docs](https://www.chromatic.com/docs/turbosnap/),
[Playwright docs](https://www.chromatic.com/docs/playwright/),
[Cypress docs](https://www.chromatic.com/docs/cypress/).

**What you pay for:** billed snapshots per month. Users, projects and
collaborators are unlimited on every plan.

| Tier | Price | Included per month | Overage |
|---|---|---|---|
| Free | $0 | 5,000 snapshots (or 25k TurboSnaps) | None: testing pauses at the cap. Chrome only. |
| Starter | $179/mo | 35,000 (175k TurboSnaps) | $0.008 per snapshot |
| Pro | $399/mo | 85,000 (425k TurboSnaps) | Not published. $0.008 probably applies but is UNVERIFIED. A third party ([pricingsaas](https://pricingsaas.com/companies/chromatic/diffs/2026W30)) says the Pro overage line was removed in July 2026. |
| Enterprise | Contact sales | Unlimited | n/a |

Annual prices are not published.

**What counts as a snapshot**
- The billing docs give the formula `Tests × Builds × Browsers × Modes`, so
  every browser and every mode (viewport, theme and so on) multiplies.
- Accessibility snapshots are billed on top.
- A TurboSnap-copied (unchanged) snapshot counts as **0.2**. So do stories
  excluded with `onlyStoryNames`.
- A build with no changes is bypassed and bills 0 (CLI 17.7.0 or later).
- Without TurboSnap, unchanged snapshots bill in full.

**Pricing history**
- In 2023, skipped snapshots were "not got billed for"
  ([Wayback 2023-04-01](http://web.archive.org/web/20230401162359/https://www.chromatic.com/docs/billing)).
- Since January 2024 they bill at 1/5
  ([chromatic-docs PR #349](https://github.com/chromaui/chromatic-docs/pull/349)).
- "Standard" was renamed "Pro" in September 2025
  ([billing docs](https://www.chromatic.com/docs/billing/)).

**Other facts**
- **Retention:** at least 12 months on all plans
  ([billing docs](https://www.chromatic.com/docs/billing/)).
- **Self-host:** none. The [CLI](https://github.com/chromaui/chromatic-cli)
  is MIT; the service is proprietary.
- **Storybook:** required. "Chromatic creates and runs a Storybook archive
  based on your Playwright project … Chromatic doesn't run Playwright
  directly." Cypress works the same way.
- **Platforms:** web only.
- **AI:** a Storybook MCP server for agents
  ([chromatic.com/ai](https://www.chromatic.com/ai)). There is no AI diff
  triage.

### Percy (BrowserStack)

Sources: [pricing](https://www.browserstack.com/pricing?product=percy),
[plans and billing](https://www.browserstack.com/docs/percy/overview/plans-and-billing),
[usage FAQ](https://www.browserstack.com/support/faq/percy/usage-and-troubleshooting/how-does-percy-calculate-the-snapshot-screenshot-usage),
[Review Agent](https://www.browserstack.com/docs/app-percy/review-agent/overview),
[AI agents](https://www.browserstack.com/percy/ai-agents).

**What you pay for:** screenshots per month. Users are unlimited.

| Tier | Annual (per month) | Monthly | Included per month | Overage | History |
|---|---|---|---|---|---|
| Free | $0 | $0 | 5,000 | n/a | 30 days |
| Desktop 10k | $199 | $249 | 10,000 | $0.036 | 12 months |
| Desktop 25k | $449 | $549 | 25,000 | $0.036 (whether this applies at 25k is UNVERIFIED) | 12 months |
| Desktop & Mobile 25k | $599 | $729 | 25,000 | $0.048 | 12 months |
| Enterprise | Contact sales | | Custom | | |

App Percy (native mobile) is priced separately: Free 1,000 screenshots,
Essentials $199/mo for 10k.

**What counts as a screenshot**
- One page in one browser at one width: "two pages rendered across two
  browsers and three widths would result in twelve screenshots."
- Failed captures count: usage is "a sum of successful and unsuccessful
  snapshots".
- Unchanged shots bill in full. There is no TurboSnap equivalent. That
  absence is inferred, because no published discount was found.
- Going over the quota does not stop the service; the overage is charged
  to the card on file.

**Pricing history**
- In 2022, $149/mo bought 25,000 screenshots with overage at $0.012
  ([Wayback 2022-05-25](https://web.archive.org/web/2022/https://www.browserstack.com/pricing?product=percy)).
- Today the entry plan is $199 for 10,000 with overage at $0.036. The
  entry allowance fell by 60% and the overage rate tripled.

**Other facts**
- **Self-host:** none. The [CLI](https://github.com/percy/cli) is MIT.
- **Storybook:** not required.
- **Platforms:** desktop web, mobile browsers and native iOS/Android (App
  Percy).
- **AI:** the Visual Review Agent triages diffs into likely bugs and
  intended changes. Paid plans only, no separate price.

### Applitools

Sources: [pricing](https://applitools.com/platform-pricing/),
[terms of service](https://applitools.com/legal/terms-of-service/),
[account limits](https://applitools.com/docs/eyes/concepts/applitools-test-manager/admin/admin-account-view),
[Ultrafast Grid](https://applitools.com/docs/eyes/concepts/test-execution/ultrafast-grid),
[system overview](https://applitools.com/docs/eyes/getting-started/system-overview).

**What you pay for:** checkpoints. Starter counts page checkpoints and
component checkpoints (images under 1024×768). The higher tiers are sized
by active pages or components, with unlimited executions.

| Tier | Price | Included | Overage |
|---|---|---|---|
| Starter | $667/mo, billed annually ($8,004/yr) | 100,000 component checkpoints **or** 1,000 page checkpoints | Not published |
| Professional | Contact sales | From 150 active pages / 1,500 components; unlimited executions; "unlimited browsers and devices per Visual AI check" | n/a |
| Enterprise | Contact sales | From 350 active pages; private cloud; on-prem add-on | n/a |

**What counts as a checkpoint**
- The ToS says "every execution of a visual validation will be counted as
  one (1) Checkpoint". Unchanged shots are therefore billed (inferred from
  that wording).
- Whether each Ultrafast Grid browser counts as a separate checkpoint is
  UNVERIFIED. Professional's "unlimited browsers per check" suggests the
  multiplier exists below that tier.

**Free tier:** a trial only. The ToS allows 100 checkpoints per user per
month for non-commercial evaluation. Over-limit use is throttled, not billed.

**Other facts**
- **Retention:** not published.
- **Self-host:** on-prem is an Enterprise add-on. It is proprietary and its
  price is not published.
- **Storybook:** optional (it is the component path).
- **Platforms:** web, mobile and desktop SDKs; real devices are an
  Enterprise add-on.
- **AI:** Visual AI matching is the core product, plus an MCP server and
  autonomous testing.
- **Seats:** unlimited users on all tiers.

### Happo

Sources: [pricing](https://happo.io/pricing),
[on-prem post](https://happo.io/blog/total-control-and-security-with-happo-on-premise-solutions)
(updated 2025-09-17). Client licences come from the GitHub API for
[happo.io](https://github.com/happo/happo.io) and
[happo](https://github.com/happo/happo).

**What you pay for:** snapshots per month. "$0 a seat, on every plan."

| Tier | Price | Included per month | Overage | Browsers |
|---|---|---|---|---|
| Free | $0 | 5,000 | None: pauses at the cap | Chrome |
| Starter | $149 | 50,000 | $0.006 | Chrome, Firefox |
| Growth | $399 | 150,000 | $0.006 | + Safari |
| Pro | $749 | 300,000 | $0.006 | + iOS Safari, Edge |
| Enterprise | Custom | 1M and up | not published | all; SSO |

Annual billing exists on Pro and Enterprise, but no annual price is
published. You can set a budget cap on overage.

**What counts as a snapshot**
- One shot in one "target". "Each browser, and the accessibility check, is a
  target. Add one in dark mode or at another size, and it counts too."
- Unchanged shots on full runs are billed. Partial runs bill only what Happo
  actually re-renders.
- An animated shot counts as 3.

**Other facts**
- **Retention:** not published.
- **Self-host:** an on-prem bundle with a 3-month trial. It is proprietary,
  priced through sales, and it is unclear whether it is still offered.
- **Licences:** the client libraries are MIT.
- **Storybook:** not required.
- **Platforms:** web, plus iOS and Android through the API.
- **AI:** an MCP server and API so agents can read diffs. There is no AI
  judging.

### Argos

Sources: [pricing](https://argos-ci.com/pricing),
[docs](https://argos-ci.com/docs/llms-full.txt) ("Argos pricing plans" and
"Usage & spend management"),
[LICENSE](https://github.com/argos-ci/argos/blob/main/LICENSE).

**What you pay for:** screenshots per month. Team members and projects are
unlimited.

| Tier | Price | Included per month | Overage | Media retention |
|---|---|---|---|---|
| Hobby | $0 | 5,000 | None: uploads pause | 30 days |
| Pro | $100/mo | 35,000 | **$0.004** standard, **$0.0015** Storybook | 1 year |
| Enterprise | Custom | Custom | not published | not published |

Pro add-ons: GitHub SSO $50/mo, SAML SSO $200/mo.

**What counts as a screenshot**
- "Every snapshot Argos stores for a build counts as one screenshot."
- "Unchanged screenshots count."
- Each browser and viewport is a separate capture in your own CI, so they
  multiply the count. This is implied by the docs' "Playwright project per
  viewport" guidance rather than stated as a rule.
- A video counts as 25.
- Failed builds: the pricing FAQ says they are not counted, but the docs say
  "Failed builds count." The two pages contradict each other.

**Other facts**
- **Licence:** MIT, for the whole platform ("no closed-source component").
- **Self-host:** "not officially supported or documented". It needs Postgres,
  RabbitMQ, Redis, S3, DynamoDB, a GitHub App and Stripe.
- **Storybook:** not required. It works with Playwright, Cypress, Vitest,
  WebdriverIO, Puppeteer, or plain CLI upload.
- **Platforms:** web.
- **AI:** "deterministic pixel diffing, not AI-based visual comparison". It
  has an MCP server and flaky-test detection.

### Lost Pixel: sunset

Lost Pixel's team joined Figma on 2026-04-22
([announcement](https://lost-pixel.com/blog/lost-pixel-team-is-joining-figma))
and the [repo](https://github.com/lost-pixel/lost-pixel) is archived. The
announcement gives no shutdown date and no migration path.

The [pricing page](https://www.lost-pixel.com/pricing) still lists its last
tiers: Free (7,000 screenshots), Startup ($100 for 40,000), up to Scale ($670 for 300,000, overage
$0.004).

- **Licence:** the engine is MIT. The review UI was platform-only, never
  self-hostable.
- **Storybook:** not required.
- **AI:** none.

### Meticulous

Meticulous no longer has a pricing page: `/pricing` returns 404 and the site
has no Pricing link. The last capture is from
[Wayback, 2024-05-21](https://web.archive.org/web/20240521204545/https://www.meticulous.ai/pricing):
Free for one user, Starter $399/mo for up to two users, Growth custom. It
priced **per user, not per snapshot**, so it does not fit the cost table.

It records real user sessions and replays them in Chrome only
([architecture](https://app.meticulous.ai/docs/concepts/architecture-overview.md)).
That means there is no browser multiplier and no Storybook.

- **Platforms:** web only.
- **Self-host:** none found.
- **AI:** AI-curated test suite and an MCP server. The diffing itself is
  pixel-by-pixel.

### Free and self-host baselines

| Tool | Licence | What it is | What it lacks |
|---|---|---|---|
| Playwright `toHaveScreenshot` ([docs](https://playwright.dev/docs/test-snapshots)) | Apache-2.0 | pixelmatch against baselines committed to git. Waits until two consecutive shots match. Baselines are per browser and per OS. | No review or approval UI: you approve with `--update-snapshots`. Rendering differs across OSes ("run tests in the same environment where the baseline screenshots were generated"), so teams pin to the Playwright Docker image. |
| [BackstopJS](https://github.com/garris/BackstopJS) | MIT | Config-driven captures and a static HTML report. Active (last push 2026-10-10). | Approval means re-baselining. No hosted review. |
| [reg-suit](https://github.com/reg-viz/reg-suit) | MIT | Diffs a directory of images, publishes the report to S3/GCS and comments on the PR. Active. | No review state of its own. |
| [Visual Regression Tracker](https://github.com/Visual-Regression-Tracker/Visual-Regression-Tracker) | Apache-2.0 | Self-hosted Docker server with an approval UI. | Small project (about 720 stars). |

## Cost at three sizes

These are the monthly costs of the cheapest published plan that fits, plus
overage where a rate is published. The assumptions:

- **The volumes are billed units after multiplying.** For example,
  200 stories × 2 browsers × 2 viewports × 25 builds = 20k a month.
- **List prices, monthly billing,** except Percy and Applitools, whose
  headline prices are annual-billed.
- **No TurboSnap or partial-run savings** in the main columns. The TurboSnap
  effect is shown separately below.

| Vendor | 2k/mo | 20k/mo | 200k/mo |
|---|---|---|---|
| Chromatic | $0 (Free) | $179 (Starter) | $1,499 (Starter + 165k × $0.008). Pro would be $1,319 if the $0.008 rate applies to it (UNVERIFIED). |
| Percy | $0 (Free) | $449 (Desktop 25k, annual). $549 billed monthly. | $6,749 annual, $6,849 monthly (Desktop 25k + 175k × $0.036; the $0.036 rate at 25k is UNVERIFIED). Realistically contact sales. |
| Applitools | Not published. As component checkpoints it would be $667 on Starter; as page checkpoints, 2k is already over Starter's 1,000 limit. | Not published. Same split: $667 as component checkpoints, contact sales as page checkpoints. | Not published (contact sales). |
| Happo | $0 (Free, Chrome only). $149 for Firefox; $399 for Safari. | $149 (Starter) | $699 (Growth + 50k × $0.006) |
| Argos | $0 (Hobby) | $100 (Pro) | $760 (Pro + 165k × $0.004). $347.50 for Storybook shots. |
| Lost Pixel (sunset) | $0 | $100 | $670 (Scale) |
| Meticulous | Not published (priced per user) | Not published | Not published |
| Playwright | $0 + CI time | $0 + CI time | $0 + CI time |

**How much TurboSnap saves.** If 80% of 200k Chromatic shots are unchanged
and copied, the bill is 40k + 160k × 0.2 = 72k billed snapshots. That fits
inside Pro at $399. Only Chromatic discounts unchanged shots this way, and it
only works with Storybook. TurboSnap can also fail silently and fall back to
a full capture of every story (see sugartown#155 below).

## Public complaints

Most of the cost complaints are first-hand GitHub issues and pull requests.
Hacker News and Reddit turned up almost nothing first-hand, and I found no
first-hand complaint about Applitools.

| Who / where | Date | Quote |
|---|---|---|
| [ComplyAdvantage engineering blog](https://technology.complyadvantage.com/how-we-cut-our-chromatic-costs-by-60-a-visual-testing-optimisation-story/) | 2026-04-29 | Chromatic usage went from about 133k to 365k a month: "more developers × slower CI/CD × more rebases = exponentially more snapshots" |
| [chromatic-cli#1203](https://github.com/chromaui/chromatic-cli/issues/1203) | 2025-09-02 | "I am trying to reduce rampant costs". Required PR checks force a full build. |
| [sugartown#155](https://github.com/bex-sugartown/sugartown/issues/155) | 2026-10-11 | TurboSnap silently bailed: "Every build since … captures the full suite" |
| [Sourcegraph#10666](https://github.com/sourcegraph/sourcegraph-public-snapshot/issues/10666) | 2020-05-14 | "much higher pricing for percy … I disabled Firefox snapshot tests, which cut down usage by 50%" |
| [MUI mui-public#1446](https://github.com/mui/mui-public/issues/1446) | 2026-05-11 | About **Argos**: "Real argos cost is 10x what we pay … screenshot testing should be unbounded" |
| [gamelord#373](https://github.com/ryanmagoon/gamelord/issues/373) | 2026-04-15 | Chromatic "slow and paid"; "a real gap in the market for a self-hosted, open source visual regression review UI" |

Teams are migrating off right now: Percy to plotly's own nitpix
([dash#3873](https://github.com/plotly/dash/pull/3873)), Chromatic to Argos
([FormSG#10329](https://github.com/opengovsg/FormSG/issues/10329)), and
Chromatic to Playwright in Docker
([box-ui-elements#4887](https://github.com/box/box-ui-elements/pull/4887)).

**The pattern in these complaints:** the bill multiplies with team activity
(builds × browsers × viewports), not only with how much UI there is to check,
and the teams above cut coverage (fewer browsers, fewer runs) to control it.

## What this means for PixelSlash pricing

These are proposals only. Jacobus decides in Decide: positioning (ob 1426).

The opening:
- Lost Pixel is gone.
- Argos's open-source code cannot be self-hosted in a supported way.
- Playwright, BackstopJS and reg-suit have no review state.
- Chromatic needs Storybook.

The one live *free* self-hosted tool with an approval UI is Visual Regression
Tracker (Apache-2.0, small; no hosted offer found). Happo's and Applitools'
on-prem have review UIs but are paid and proprietary; Argos's is unsupported.
So "free, supported self-host, not Storybook-bound, with a review UI **and** a
hosted option" is not offered by anyone today. On the hosted side, the
vendors that publish rates meter things the customer does not see as value: unchanged shots, browser
multipliers, and (Percy, Argos) failed runs.

**Shape A: meter only changed shots.**
- Unchanged and failed shots are free; a billable unit is a shot whose diff
  is non-zero and is kept for review.
- A hosted free tier with bring-your-own model; paid tiers include our judge.
- *For:* it directly answers the "exponentially more snapshots" complaint,
  and it is easy to explain against Chromatic's 0.2 TurboSnap rule.
- *Against:* revenue tracks churn in the UI, so a stable product pays little.
  We still pay for storing and diffing every shot.

**Shape B: flat per-project tiers with unlimited shots and fair-use storage.**
- For example, Free (BYO model, short retention); Team ≈ Argos Pro price
  (our judge included, 1 yr retention); Business adds SSO.
- *For:* MUI's "screenshot testing should be unbounded", and no bill
  surprises.
- *Against:* heavy users cost us storage and compute. It needs a retention
  or storage cap and a documented fair-use line.

**Shape C: conventional metering, priced under the field, with the AI judge
billed separately.**
- Shots per month with no browser multiplier on Free, and overage below
  Argos's $0.004. Judge calls are their own meter (BYO model = free).
- *For:* familiar to buyers, easy to compare, and the judge cost is visible.
- *Against:* it competes on price alone in a market where Argos is already
  $100/35k. Two meters are harder to explain.

Candidate guardrails that would apply to any shape (also for 1426 to accept
or reject):
- Never bill failed captures.
- Publish every overage rate.
- Pause at the cap only on Free; never pause a paid tier.
