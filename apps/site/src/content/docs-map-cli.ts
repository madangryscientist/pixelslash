import type { DocPageDef } from "./docs-map.ts";

/*
 * The Capture and Review server pages: each a cut of docs/cli.md. They live here so docs-map.ts
 * stays a readable list; `DOC_PAGES` spreads each group in place.
 */
export const CAPTURE_PAGES: readonly DocPageDef[] = [
  {
    slug: "capture",
    title: "Capture in CI",
    group: "capture",
    sections: ["Snapshot capture (the pinned image)"],
    exits: true,
  },
  {
    slug: "capture-config",
    title: "The config file",
    group: "capture",
    sections: ["The config file", "Tolerance, flaky policy and retries"],
    exits: true,
  },
  {
    slug: "capture-variants",
    title: "Variants",
    group: "capture",
    sections: ["Variants: browsers, viewports and themes"],
  },
  {
    slug: "capture-setup",
    title: "Sign-in and Storybook",
    group: "capture",
    sections: ["Pages behind a sign-in: setup", "Storybook stories"],
    exits: true,
  },
  {
    slug: "capture-masks",
    title: "Masks and ignore areas",
    group: "capture",
    sections: ["Masks and ignore areas"],
  },
  {
    slug: "capture-stabilise",
    title: "Stabilise",
    group: "capture",
    sections: ["Stabilise: what is frozen before a shot"],
  },
  {
    slug: "capture-composition",
    title: "Composition",
    group: "capture",
    sections: ["Composition-only projects: what is styled outside the library"],
  },
  {
    slug: "capture-a11y",
    title: "Accessibility and layout metrics",
    group: "capture",
    sections: [
      "Accessibility checks: violations that are new on Branch",
      "Layout metrics per shot",
    ],
  },
  {
    slug: "playwright",
    title: "Capture from Playwright tests",
    group: "capture",
    sections: ["Snapshots from your own Playwright tests"],
    exits: true,
  },
  {
    slug: "pngs",
    title: "Import PNGs",
    group: "capture",
    sections: ["Snapshots from PNGs you already have"],
    exits: true,
  },
  {
    slug: "pngs-native",
    title: "Native screenshots",
    group: "capture",
    sections: ["Native screenshots (Maestro)"],
  },
  {
    slug: "twins",
    title: "Twins across platforms",
    group: "capture",
    sections: ["Twins across platforms", "Stale twins"],
  },
  {
    slug: "parity",
    title: "Parity between platforms",
    group: "capture",
    sections: ["Parity between twins", "Release check", "Parity view"],
    exits: true,
  },
  {
    slug: "compare-dirs",
    title: "Compare two snapshot dirs",
    group: "capture",
    sections: ["Comparing two snapshot dirs"],
    exits: true,
  },
  {
    slug: "metrics",
    title: "Layout metrics file",
    group: "capture",
    sections: [],
    file: "docs/metrics.md",
  },
];

export const REVIEW_PAGES: readonly DocPageDef[] = [
  {
    slug: "signing-in",
    title: "Sign in and read builds",
    group: "review",
    sections: ["Signing in and reading builds"],
    exits: true,
  },
  {
    slug: "upload",
    title: "Upload to a server",
    group: "review",
    sections: ["Uploading to a server"],
    exits: true,
  },
  {
    slug: "upload-flaky",
    title: "Flaky shot detection and policy",
    group: "review",
    sections: ["Flaky shots", "Fixing a flake locally"],
    exits: true,
  },
  {
    slug: "upload-baselines",
    title: "Baseline rules",
    group: "review",
    sections: ["Baseline rules: what a shot is compared against"],
  },
  {
    slug: "block-ci",
    title: "Block CI on review",
    group: "review",
    sections: ["Block CI on review"],
    exits: true,
  },
  {
    slug: "monorepo-tokens",
    title: "A monorepo and its tokens",
    group: "review",
    sections: ["A monorepo: one org token"],
    exits: true,
  },
  {
    slug: "check",
    title: "Check before you push",
    group: "review",
    sections: ["Check before you push"],
    exits: true,
  },
];
