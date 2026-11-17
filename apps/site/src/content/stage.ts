/**
 * The product's release stage, and the one sentence saying what it means for a user. Every Hack
 * Cove site states its stage in the same words, so a visitor learns one vocabulary across all of
 * them. Moving a product on is this file's one edit: `STAGE` picks the row, and the home page and
 * the footer both read it from there.
 */
type StageId = "alpha" | "beta" | "release-candidate" | "stable" | "planned";

export const STAGES: Record<StageId, { label: string; sentence: string }> = {
  alpha: {
    label: "Alpha",
    sentence: "Changing fast. Expect breaking changes between versions.",
  },
  beta: {
    label: "Beta",
    sentence:
      "Settling. Breaking changes are still possible and are called out in the release notes.",
  },
  "release-candidate": {
    label: "Release candidate",
    sentence: "Feature complete. Breaking changes are rare and announced ahead.",
  },
  stable: {
    label: "Stable",
    sentence: "No breaking changes within a major version.",
  },
  planned: {
    label: "Planned",
    sentence: "Not built yet.",
  },
};

/** Where PixelSlash is today. */
export const STAGE: StageId = "alpha";

/** The stage as the one line a page prints: `Alpha. Changing fast. Expect breaking changes ...`. */
export const STAGE_LINE = `${STAGES[STAGE].label}. ${STAGES[STAGE].sentence}`;
