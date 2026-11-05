/*
 * Where the docs live on the site, in one place. `docs/cli.md` stays one file and the contract;
 * the site cuts it at build time into the pages below, each owning whole sections of it.
 * `sections` are heading texts of cli.md: an H2 brings its subsections along, and an H3 listed
 * here is cut out of its H2 and shown on this page instead. A test (docs.test.tsx) fails when an
 * H2 of cli.md is on no page, on two, or a listed heading no longer exists, so this cannot rot.
 *
 * Plain data, no imports: vite.config.ts reads it to prerender a page per entry.
 */

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
] as const;

export type GroupId = (typeof GROUPS)[number]["id"];

export type DocPageDef = {
  slug: string;
  /** The page's heading and its entry in the nav. */
  title: string;
  group: GroupId;
  /** Headings of docs/cli.md this page shows (plain text, as the heading reads). */
  sections: readonly string[];
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
    | "docs/ci/review-server.md";
};

export const DOC_PAGES: readonly DocPageDef[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    group: "start",
    sections: [],
    file: "docs/getting-started.md",
  },
  { slug: "install", title: "Install", group: "start", sections: ["Install"] },
  {
    slug: "init",
    title: "Start a repo",
    group: "start",
    sections: ["Start a repo: pixelslash init"],
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
  {
    slug: "capture",
    title: "Capture in CI",
    group: "capture",
    sections: ["Snapshot capture (the pinned image)"],
  },
  {
    slug: "playwright",
    title: "Your own Playwright tests",
    group: "capture",
    sections: ["Snapshots from your own Playwright tests"],
  },
  {
    slug: "pngs",
    title: "PNGs and snapshot dirs",
    group: "capture",
    sections: ["Snapshots from PNGs you already have", "Comparing two snapshot dirs"],
  },
  {
    slug: "metrics",
    title: "Layout metrics file",
    group: "capture",
    sections: [],
    file: "docs/metrics.md",
  },
  {
    slug: "compare",
    title: "Compare two versions",
    group: "diff",
    sections: ["Compare two versions"],
  },
  {
    slug: "diff",
    title: "How the diff works",
    group: "diff",
    sections: ["How the diff works", "Tuning the diff"],
  },
  { slug: "report", title: "The report", group: "diff", sections: ["The report"] },
  {
    slug: "judge",
    title: "The judge",
    group: "judge",
    sections: ["The design-system judge"],
  },
  {
    slug: "signing-in",
    title: "Sign in and read builds",
    group: "review",
    sections: ["Signing in and reading builds"],
  },
  {
    slug: "upload",
    title: "Upload and block CI",
    group: "review",
    sections: ["Uploading to a server"],
  },
  {
    slug: "dev",
    title: "Feature mode",
    group: "build",
    sections: ["Feature mode: pixelslash dev"],
  },
  {
    slug: "mcp",
    title: "Your coding agent",
    group: "agents",
    sections: ["Your coding agent: pixelslash mcp"],
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
