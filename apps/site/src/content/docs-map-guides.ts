import type { DocPageDef } from "./docs-map.ts";

/*
 * The Concepts and Help pages: a repo file of its own per page, rather than a cut of docs/cli.md.
 * They live here so docs-map.ts stays a readable list; `DOC_PAGES` spreads each group in place.
 */
export const CONCEPT_PAGES: readonly DocPageDef[] = [
  {
    slug: "how-a-comparison-works",
    title: "How a comparison works",
    group: "concepts",
    sections: [],
    file: "docs/concepts/how-a-comparison-works.md",
  },
  {
    slug: "baselines-and-branches",
    title: "Baselines and branches",
    group: "concepts",
    sections: [],
    file: "docs/concepts/baselines-and-branches.md",
  },
  {
    slug: "thresholds",
    title: "Thresholds",
    group: "concepts",
    sections: [],
    file: "docs/concepts/thresholds.md",
  },
  {
    slug: "ignore-or-redact",
    title: "Ignore or redact",
    group: "concepts",
    sections: [],
    file: "docs/concepts/ignore-or-redact.md",
  },
  {
    slug: "flaky-shots",
    title: "Flaky shots",
    group: "concepts",
    sections: [],
    file: "docs/concepts/flaky-shots.md",
  },
  {
    slug: "fingerprints",
    title: "Fingerprints and environments",
    group: "concepts",
    sections: [],
    file: "docs/concepts/fingerprints.md",
  },
  {
    slug: "reading-a-report",
    title: "Reading a report",
    group: "concepts",
    sections: [],
    file: "docs/concepts/reading-a-report.md",
  },
  {
    slug: "review-flow",
    title: "The review flow",
    group: "concepts",
    sections: [],
    file: "docs/concepts/review-flow.md",
  },
];

export const HELP_PAGES: readonly DocPageDef[] = [
  {
    slug: "exit-codes",
    title: "Exit codes in plain words",
    group: "help",
    sections: [],
    file: "docs/help/exit-codes.md",
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "help",
    sections: [],
    file: "docs/help/troubleshooting.md",
  },
  {
    slug: "faq",
    title: "FAQ",
    group: "help",
    sections: [],
    file: "docs/help/faq.md",
  },
  {
    slug: "coming-from-chromatic",
    title: "Coming from Chromatic",
    group: "help",
    sections: [],
    file: "docs/help/coming-from-chromatic.md",
  },
];
