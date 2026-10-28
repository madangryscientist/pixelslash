// Typecheck-only (PS-237): the declarations the package ships (`types/index.d.ts`) restate the public
// surface, because the bundle inlines the engine. This file fails `tsc` when they drift from the source:
// what the source takes and returns must fit what the shipped types promise.
import type * as shipped from "../types/index.ts";
import type * as source from "../src/index.ts";

type Fits<A, B> = [A] extends [B] ? true : false;
type Assert<T extends true> = T;

// Options: both ways, a key one has and the other lacks is a drift.
export type Check1 = Assert<Fits<shipped.SnapshotOptions, source.SnapshotOptions>>;
export type Check2 = Assert<Fits<source.SnapshotOptions, shipped.SnapshotOptions>>;
// What snapshot() resolves to is what the shipped entry describes, and the shipped entry has no key
// the source lacks (the source has more: the optional fields only `capture` writes).
export type Check3 = Assert<
  Fits<Awaited<ReturnType<typeof source.snapshot>>, shipped.SnapshotEntry>
>;
export type Check4 = Assert<
  Fits<keyof shipped.SnapshotEntry, keyof Awaited<ReturnType<typeof source.snapshot>>>
>;
export type Check5 = Assert<Fits<typeof source.keepNativeRaf, typeof shipped.keepNativeRaf>>;
