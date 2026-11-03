import type { Metrics } from "./metrics-entry.ts";
import type { ParityField, ParityPlatform, ParityValue } from "./parity-manifest.ts";

/** The shapes `compareParity` takes and gives (PS-296). Types only. */

export type ParitySide = {
  platform: ParityPlatform;
  /** A native side's `fingerprint.scale`; a web side's deviceScaleFactor if recorded. null reads as 1. */
  scale: number | null;
  metrics: Metrics;
};

export type MismatchKind = "missing-part" | "length" | "exact" | "color";

export type Mismatch = {
  part: string;
  /** null for a part one side does not have. */
  field: ParityField | null;
  kind: MismatchKind;
  /** Each side's value; null on the side a missing part is missing from. */
  values: Partial<Record<ParityPlatform, ParityValue | null>>;
  sentence: string;
};

/** What a declaration did in one pair: it covered the field, or why it no longer does. */
export type DeclarationStatus = "applied" | "agreed" | "moved" | "unmeasured";

export type DeclarationUse = {
  key: string;
  part: string;
  field: ParityField;
  status: DeclarationStatus;
  /** Why a declaration that did not apply is stale, in words. */
  detail: string;
};

export type ParitySideInfo = {
  platform: ParityPlatform;
  scale: number;
  /** `recorded` when the file's snapshot carried a scale; `default` when 1 was assumed. */
  scale_source: "recorded" | "default";
};

export type ParityPair = {
  name: string;
  theme: string;
  sides: [ParitySideInfo, ParitySideInfo];
  /** The logical-px tolerance for lengths: `max(1/scale_a, 1/scale_b)`. */
  tolerance: number;
  mismatches: Mismatch[];
  /** Differences the manifest declares on purpose: compared, differing, and accepted. */
  declared: Mismatch[];
  declarations: DeclarationUse[];
  /** One sentence for the pair, `null` when there is no drift. */
  line: string | null;
};

export type StaleDeclaration = { key: string; part: string; field: ParityField; sentence: string };
