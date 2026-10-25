/** One half of `--decode parallel` (ob 1932): decode the path it is sent, off the main thread. */
import type { DecoderName } from "./ts-codecs.ts";
import { decodeFile, type Decoded } from "./ts-decode.ts";

export type WorkerRequest = { path: string; decoder: DecoderName };
export type WorkerReply = { ok: true; decoded: Decoded } | { ok: false; message: string };

declare const self: Worker;

async function answer(request: WorkerRequest): Promise<void> {
  try {
    const decoded = await decodeFile(request.path, request.decoder);
    const { data } = decoded.raster;
    // Hand the pixels over instead of copying them, when the buffer is theirs alone (not a pooled slab).
    const { buffer } = data;
    const owned = data.byteOffset === 0 && data.byteLength === buffer.byteLength;
    const reply: WorkerReply = { ok: true, decoded };
    if (!owned || !(buffer instanceof ArrayBuffer)) self.postMessage(reply, { transfer: [] });
    else
      try {
        self.postMessage(reply, { transfer: [buffer] });
      } catch {
        // A native addon's external memory (sharp, jsquash) cannot be transferred; it is copied.
        self.postMessage(reply, { transfer: [] });
      }
  } catch (e) {
    const reply: WorkerReply = { ok: false, message: e instanceof Error ? e.message : String(e) };
    self.postMessage(reply, { transfer: [] });
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => void answer(event.data));
