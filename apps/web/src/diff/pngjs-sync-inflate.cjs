/**
 * pngjs's sync inflate builds on Node's `zlib.Inflate` stream, subclassing it and calling it
 * with `.call`. workerd (Cloudflare Workers) implements `zlib.Inflate` as a real ES class, so
 * that call throws "Class constructor Inflate cannot be invoked without 'new'" and every PNG
 * decode fails — measured in the upload e2e (ob 1470).
 *
 * workerd's `zlib.inflateSync` does work, so the server build swaps pngjs's compatibility
 * wrapper for this one. Only the wrapper changes: pngjs still reads, filters and unfilters
 * every chunk itself. Wired in twice in `vite.config.ts`: by the resolver plugin for the build, and by the ssr
 * `optimizeDeps` plugin for `vite dev`, which pre-bundles pngjs without running resolver plugins; Bun and Node keep
 * pngjs's own version, so the CLI and the tests are untouched.
 *
 * It also frees what it inflates (PS-200). That buffer is the whole image again (~25 MB for a
 * full-page shot) and pngjs drops it once it has unfiltered it, but a Worker has no `gc()` and a
 * burst of them left workerd holding gigabytes. pngjs reads synchronously, so by the next
 * microtask it is done with the buffer and nothing reads it again.
 */
const { inflateSync } = require("node:zlib");

module.exports = (buffer) => {
  const inflated = inflateSync(buffer);
  const store = inflated.buffer;
  if (
    store.byteLength >= 1 << 20 &&
    inflated.byteOffset === 0 &&
    inflated.byteLength === store.byteLength
  )
    queueMicrotask(() => {
      try {
        store.transfer(0);
      } catch {
        // Not detachable here: the collector gets it.
      }
    });
  return inflated;
};
