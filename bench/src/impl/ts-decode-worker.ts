/** One half of `--decode parallel` (ob 1932): decode the path it is sent, off the main thread. */
import { decodeFile, type Decoded } from "./ts-decode.ts";

export type WorkerReply = { ok: true; decoded: Decoded } | { ok: false; message: string };

declare const self: Worker;

self.addEventListener("message", (event: MessageEvent<string>) => {
  try {
    const decoded = decodeFile(event.data);
    const { data } = decoded.raster;
    // Hand the pixels over instead of copying them, when the buffer is theirs alone (not a pooled slab).
    const { buffer } = data;
    const owned = data.byteOffset === 0 && data.byteLength === buffer.byteLength;
    const reply: WorkerReply = { ok: true, decoded };
    self.postMessage(reply, { transfer: owned && buffer instanceof ArrayBuffer ? [buffer] : [] });
  } catch (e) {
    const reply: WorkerReply = { ok: false, message: e instanceof Error ? e.message : String(e) };
    self.postMessage(reply, { transfer: [] });
  }
});
