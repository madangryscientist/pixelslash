/** Resolve once everything written to `stream` has been handed to the OS, or the stream failed. */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((done) => {
    if (stream.destroyed || stream.writableFinished) {
      done();
      return;
    }
    // A reader that went away (EPIPE) must not keep the process from exiting.
    stream.once("error", () => done());
    // Bun's `process.stdout` has no usable drain signal on a pipe: `writableNeedDrain` stays
    // false, and the callback of an empty `write` runs before the pipe has emptied (measured
    // with a 2 MB write: 128 KB to 3 MB lost, run to run). `end` waits for the pipe. Nothing
    // writes after this, because the process exits next.
    stream.end(() => done());
  });
}

/**
 * Exit with `code` once stdout and stderr have drained. A bare `process.exit` drops whatever a pipe
 * still holds, which cut `build --json` off at about 128 KB when it was piped.
 */
export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
