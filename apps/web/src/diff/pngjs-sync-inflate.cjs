/**
 * pngjs's sync inflate builds on Node's `zlib.Inflate` stream, subclassing it and calling it
 * with `.call`. workerd (Cloudflare Workers) implements `zlib.Inflate` as a real ES class, so
 * that call throws "Class constructor Inflate cannot be invoked without 'new'" and every PNG
 * decode fails — measured in the upload e2e (ob 1470).
 *
 * workerd's `zlib.inflateSync` does work, so the server build swaps pngjs's compatibility
 * wrapper for this one. Only the wrapper changes: pngjs still reads, filters and unfilters
 * every chunk itself. Wired in by the resolver plugin in `vite.config.ts`; Bun and Node keep
 * pngjs's own version, so the CLI and the tests are untouched.
 */
const { inflateSync } = require("node:zlib");

module.exports = (buffer) => inflateSync(buffer);
