/**
 * Give a large pixel buffer back now (PS-200). A Worker has no `gc()`, and the runtime counts a
 * typed array's backing store as external memory the collector reacts to late: a burst of
 * full-page diffs left workerd holding gigabytes of dead rasters until it restarted. Moving the
 * store to a zero-length `ArrayBuffer` detaches the old one and frees the bytes at once.
 *
 * Only call this on a buffer nothing reads again. Where it cannot detach (an old runtime, or a
 * store another owner holds, such as a native codec's) the buffer is left for the collector.
 */
export function release(...buffers: (Uint8Array | Buffer | false | undefined)[]): void {
  for (const bytes of buffers) if (bytes) releaseOne(bytes);
}

/** Run `work`, then free the buffers it was given: they are the caller's own and dead after it. */
export function releasing<T>(buffers: (Uint8Array | Buffer)[], work: () => T): T {
  try {
    return work();
  } finally {
    release(...buffers);
  }
}

function releaseOne(bytes: Uint8Array | Buffer): void {
  const store = bytes.buffer;
  if (!(store instanceof ArrayBuffer)) return;
  // `transfer` is ES2024; the web project's `lib` predates it, so it is read untyped.
  const transfer: unknown = Reflect.get(store, "transfer");
  if (typeof transfer !== "function") return;
  if (store.byteLength < MIN_RELEASE_BYTES) return;
  if (bytes.byteOffset !== 0 || bytes.byteLength !== store.byteLength) return;
  try {
    Reflect.apply(transfer, store, [0]);
  } catch {
    // Not detachable here: the collector gets it.
  }
}

/** Below this the collector is fine, and a view onto a shared pool must not be detached. */
const MIN_RELEASE_BYTES = 1 << 20;
