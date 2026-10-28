// What `@hackcove/pixelslash-playwright` takes from the engine, and nothing else (PS-237). Its bundle
// runs under plain Node, so this entry is the one place that decides what the bundle pulls in: no
// module reachable from here may touch a Bun API. `packages/playwright/test` bundles it and fails on a
// `Bun` reference.
export { keepNativeRaf, settleCapture } from "./settle.ts";
export { fontSetHash, imageId, type Fingerprint } from "./fingerprint.ts";
export { identity, pngPath } from "./snapshot-paths.ts";
export { MASK_COLOR, maskLocators, measureIgnore, toImageRects } from "./page-areas.ts";
export type { SnapshotEntry, SnapshotManifest } from "./snapshot.ts";
export { unmatchedTally } from "./unmatched.ts";
