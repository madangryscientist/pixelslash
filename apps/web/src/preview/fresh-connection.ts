import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Plugin } from "vite";

type Dispatch = (options: { reset?: boolean }, handler: unknown) => boolean;
type PoolClass = { prototype: { dispatch: Dispatch } };

/**
 * Makes `Pool` close the socket once a response is in, so it is never idle for the next request to
 * find half-dead. Miniflare passes `reset: false` on every request it sends workerd, so a
 * `Connection: close` header on the incoming request cannot do this; the flag has to be flipped
 * where the dispatch is. Only requests that say `reset: false` are touched: that is miniflare's
 * mark on the runtime's, and any other request through the same undici keeps its own.
 */
export function closeSocketAfterEachRequest(Pool: PoolClass): void {
  const dispatch = Pool.prototype.dispatch;
  Pool.prototype.dispatch = function (this: unknown, options, handler) {
    return dispatch.call(
      this,
      options.reset === false ? { ...options, reset: true } : options,
      handler,
    );
  };
}

function hasPool(module: unknown): module is { Pool: PoolClass } {
  return (
    typeof module === "object" &&
    module !== null &&
    "Pool" in module &&
    typeof module.Pool === "function" &&
    typeof module.Pool.prototype?.dispatch === "function"
  );
}

/** The `undici` that `miniflare` loads: the plugin that depends on it, then miniflare, then its undici. */
export function miniflareUndici(root: string): { Pool: PoolClass } {
  const plugin = realpathSync(join(root, "node_modules/@cloudflare/vite-plugin"));
  const miniflare = createRequire(join(plugin, "x.js")).resolve("miniflare");
  const undici: unknown = createRequire(miniflare)("undici");
  if (!hasPool(undici)) throw new Error("fresh-connection: miniflare's undici has no Pool");
  return undici;
}

/**
 * ob 1876. On the CT, workerd closes its connection about 50 ms after it answers a long finalize,
 * and the CLI's next finalize, sent at once, was dispatched on the socket miniflare's undici
 * pool had kept: `read ECONNRESET`, which the Cloudflare plugin turns into a 500 `fetch failed`
 * for a request that never ran. A localhost connect per request costs nothing next to a finalize.
 * Preview only: `vite preview` is what the self-host runs.
 */
export function freshConnectionPerRequest(): Plugin {
  return {
    name: "fresh-connection-per-request",
    configurePreviewServer(server) {
      closeSocketAfterEachRequest(miniflareUndici(server.config.root).Pool);
    },
  };
}
