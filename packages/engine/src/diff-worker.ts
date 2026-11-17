/**
 * One comparison worker of the diff pool (`diff-pool.ts`): it runs `diffPngs` or `measurePngs` on
 * the two PNGs it is sent and posts the result back. The PNG overlay goes back as a copy, so no view
 * into the wasm memory leaves the worker; an error goes back as its message.
 */
import { diffPngs, measurePngs } from "./diff.ts";
import type { DiffReply, DiffRequest } from "./diff-pool.ts";

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent<DiffRequest>) => void): void;
  postMessage(message: DiffReply, options: { transfer: ArrayBuffer[] }): void;
};

self.addEventListener("message", (event) => {
  const { id, kind, main, branch, options, ignore } = event.data;
  try {
    const run = kind === "measure" ? measurePngs : diffPngs;
    const { overlay, ...rest } = run(Buffer.from(main), Buffer.from(branch), options, ignore);
    const copy = overlay ? new Uint8Array(overlay) : null;
    const transfer = copy ? [copy.buffer] : [];
    self.postMessage({ id, ok: true, result: { ...rest, overlay: copy } }, { transfer });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    self.postMessage({ id, ok: false, message }, { transfer: [] });
  }
});
