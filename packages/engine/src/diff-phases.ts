/**
 * Where a diff's time went, in ms, by the bench contract's phase names (PS-212). `pixel_compare`
 * includes the anti-alias test: the module has no clock to split them.
 */
export type WasmPhases = Record<string, number>;

/** `fn`'s result, its time added to `phases[name]` when there are phases to fill. */
export function timed<T>(phases: WasmPhases | undefined, name: string, fn: () => T): T {
  if (!phases) return fn();
  const started = performance.now();
  const result = fn();
  phases[name] = (phases[name] ?? 0) + performance.now() - started;
  return result;
}

/** `fn`'s result, the time it spent outside the phases it timed itself added to `phases[name]`. */
export function untimed<T>(phases: WasmPhases | undefined, name: string, fn: () => T): T {
  if (!phases) return fn();
  const before = Object.values(phases).reduce((sum, ms) => sum + ms, 0);
  const started = performance.now();
  const result = fn();
  const inner = Object.values(phases).reduce((sum, ms) => sum + ms, 0) - before;
  phases[name] = (phases[name] ?? 0) + performance.now() - started - inner;
  return result;
}
