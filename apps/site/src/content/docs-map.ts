/*
 * Where the docs live on the site, in one place. `docs/cli.md` stays one file and the contract;
 * the site cuts it at build time into the pages below, each owning whole sections of it.
 * `sections` are heading texts of cli.md: an H2 brings its subsections along, and an H3 listed
 * here is cut out of its H2 and shown on this page instead. A test (docs.test.tsx) fails when an
 * H2 of cli.md is on no page, on two, or a listed heading no longer exists, so this cannot rot.
 *
 * Plain data only: vite.config.ts reads it to prerender a page per entry, and the Concepts and
 * Help pages live in docs-map-guides.ts so this list stays readable.
 */

import { CAPTURE_PAGES, REVIEW_PAGES } from "./docs-map-cli.ts";
import { CONCEPT_PAGES, HELP_PAGES } from "./docs-map-guides.ts";

export const GROUPS = [
  { id: "start", title: "Get started", summary: "Install it and run a first compare." },
  {
    id: "tutorials",
    title: "Tutorials",
    summary: "One route from nothing to a report, per way of capturing.",
  },
  {
    id: "ci",
    title: "Run it in CI",
    summary: "A complete setup per CI provider, pinned versions and the gate.",
  },
  {
    id: "capture",
    title: "Capture",
    summary: "Shoot pages in CI, from your tests, or reuse PNGs.",
  },
  { id: "diff", title: "The diff and report", summary: "How two shots are compared and shown." },
  {
    id: "concepts",
    title: "Concepts",
    summary: "The ideas behind a comparison, a baseline and a review.",
  },
  {
    id: "judge",
    title: "Design-system judge",
    summary: "Check a page against your design system.",
  },
  {
    id: "review",
    title: "Review server and CI",
    summary: "Sign in, upload, read builds and block CI on review.",
  },
  { id: "build", title: "While you build", summary: "Re-capture a feature as you work on it." },
  { id: "agents", title: "Agents", summary: "Drive PixelSlash from a coding agent." },
  { id: "reference", title: "Reference", summary: "The API, timings and error reporting." },
  {
    id: "help",
    title: "Help",
    summary: "Exit codes, exact error messages, questions and migration.",
  },
] as const;

export type GroupId = (typeof GROUPS)[number]["id"];

export type DocPageDef = {
  slug: string;
  /** The page's heading and its entry in the nav. */
  title: string;
  group: GroupId;
  /** Headings of docs/cli.md this page shows (plain text, as the heading reads). */
  sections: readonly string[];
  /** The page can end a run with a non-zero exit, so it links to the exit codes. */
  exits?: boolean;
  /** A page the site generates from cli.md instead of cutting it: the command index. */
  kind?: "cli-index";
  /** A page that is its own file instead of a cut of cli.md. */
  file?:
    | "docs/getting-started.md"
    | "docs/metrics.md"
    | "docs/tutorials/choose-capture.md"
    | "docs/tutorials/storybook.md"
    | "docs/tutorials/playwright.md"
    | "docs/tutorials/urls.md"
    | "docs/tutorials/pngs.md"
    | "docs/tutorials/first-review.md"
    | "docs/ci/github-actions.md"
    | "docs/ci/gitlab.md"
    | "docs/ci/circleci.md"
    | "docs/ci/jenkins.md"
    | "docs/ci/any-ci.md"
    | "docs/ci/pin-versions.md"
    | "docs/ci/review-server.md"
    | "docs/concepts/how-a-comparison-works.md"
    | "docs/concepts/baselines-and-branches.md"
    | "docs/concepts/thresholds.md"
    | "docs/concepts/ignore-or-redact.md"
    | "docs/concepts/flaky-shots.md"
    | "docs/concepts/fingerprints.md"
    | "docs/concepts/reading-a-report.md"
    | "docs/concepts/review-flow.md"
    | "docs/help/exit-codes.md"
    | "docs/help/troubleshooting.md"
    | "docs/help/faq.md"
    | "docs/help/coming-from-chromatic.md";
};

export const DOC_PAGES: readonly DocPageDef[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "start",
    sections: [],
    file: "docs/getting-started.md",
  },
  { slug: "install", title: "Install", group: "start", sections: ["Install"], exits: true },
  {
    slug: "init",
    title: "Start a repo",
    group: "start",
    sections: ["Start a repo: pixelslash init"],
    exits: true,
  },
  {
    slug: "choose-capture",
    title: "Choose how to capture",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/choose-capture.md",
  },
  {
    slug: "tutorial-storybook",
    title: "A Storybook",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/storybook.md",
  },
  {
    slug: "tutorial-playwright",
    title: "Your Playwright tests",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/playwright.md",
  },
  {
    slug: "tutorial-urls",
    title: "A site by URL",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/urls.md",
  },
  {
    slug: "tutorial-pngs",
    title: "PNGs you already have",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/pngs.md",
  },
  {
    slug: "tutorial-first-review",
    title: "Your first review",
    group: "tutorials",
    sections: [],
    file: "docs/tutorials/first-review.md",
  },
  {
    slug: "ci-github-actions",
    title: "GitHub Actions",
    group: "ci",
    sections: [],
    file: "docs/ci/github-actions.md",
  },
  {
    slug: "ci-gitlab",
    title: "GitLab CI",
    group: "ci",
    sections: [],
    file: "docs/ci/gitlab.md",
  },
  {
    slug: "ci-circleci",
    title: "CircleCI",
    group: "ci",
    sections: [],
    file: "docs/ci/circleci.md",
  },
  {
    slug: "ci-jenkins",
    title: "Jenkins",
    group: "ci",
    sections: [],
    file: "docs/ci/jenkins.md",
  },
  {
    slug: "ci-any",
    title: "Any other CI",
    group: "ci",
    sections: [],
    file: "docs/ci/any-ci.md",
  },
  {
    slug: "ci-pin-versions",
    title: "Pin versions in CI",
    group: "ci",
    sections: [],
    file: "docs/ci/pin-versions.md",
  },
  {
    slug: "ci-review-server",
    title: "Run a review server",
    group: "ci",
    sections: [],
    file: "docs/ci/review-server.md",
  },
  ...CAPTURE_PAGES,
  {
    slug: "compare",
    title: "Compare two versions",
    group: "diff",
    sections: ["Compare two versions"],
    exits: true,
  },
  {
    slug: "diff",
    title: "How the diff works",
    group: "diff",
    sections: ["How the diff works", "Tuning the diff"],
  },
  { slug: "report", title: "The report", group: "diff", sections: ["The report"] },
  ...CONCEPT_PAGES,
  {
    slug: "judge",
    title: "The judge",
    group: "judge",
    sections: ["The design-system judge"],
    exits: true,
  },
  ...REVIEW_PAGES,
  {
    slug: "dev",
    title: "Feature mode",
    group: "build",
    sections: ["Feature mode: pixelslash dev"],
    exits: true,
  },
  {
    slug: "mcp",
    title: "Your coding agent",
    group: "agents",
    sections: ["Your coding agent: pixelslash mcp"],
    exits: true,
  },
  {
    slug: "cli",
    title: "Every command",
    group: "reference",
    sections: [],
    kind: "cli-index",
  },
  { slug: "api", title: "API", group: "reference", sections: ["API"] },
  {
    slug: "timings",
    title: "Step and server timings",
    group: "reference",
    sections: ["Step timings"],
  },
  {
    slug: "error-reporting",
    title: "Error reporting",
    group: "reference",
    sections: ["Error reporting (opt-in)"],
  },
  {
    slug: "gtk",
    title: "GTK window dogfood",
    group: "reference",
    sections: ["Local-screenshot dogfood (GTK windows)"],
  },
  ...HELP_PAGES,
];

/** Pages of the site that are not docs pages but sit in the docs nav, under the group they belong to. */
export const EXTRA_NAV: readonly { group: GroupId; title: string; href: string }[] = [
  { group: "ci", title: "Self-host the review app", href: "/self-host" },
];

export function findPage(slug: string): DocPageDef | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}

/** The page before and after `slug` in nav order, across groups. */
export function neighbours(slug: string): { prev?: DocPageDef; next?: DocPageDef } {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  const prev = DOC_PAGES[index - 1];
  const next = DOC_PAGES[index + 1];
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}
