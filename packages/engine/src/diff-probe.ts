export type Raster = { data: Uint8Array; width: number; height: number };

/** The parts of a diff a probe can be told the time of (ob 1932); `anti_alias` is inside the pixel loop, so it is taken out of `pixel_compare`. */
export type DiffPhase = "pixel_compare" | "anti_alias" | "regions" | "overlay_encode";

/**
 * Optional timing hook: called once per phase with its ms. Off by default and costing a single
 * `undefined` check per pixel that needs the anti-alias test, so the benchmark can explain where the
 * time goes without the engine's output changing.
 */
export type DiffProbe = (phase: DiffPhase, ms: number) => void;

/** The clock, or 0 when nobody is listening: a probe-less diff never reads it. */
export const clock = (probe: DiffProbe | undefined): number => (probe ? performance.now() : 0);

/** The loop's time since `loopStarted`, split into the anti-alias test and the rest. */
export function reportLoop(probe: DiffProbe, antialiasMs: number, loopStarted: number) {
  probe("anti_alias", antialiasMs);
  probe("pixel_compare", performance.now() - loopStarted - antialiasMs);
}
