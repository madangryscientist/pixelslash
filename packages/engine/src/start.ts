import { CaptureError } from "./errors.ts";
import type { StartCommand } from "./config.ts";

const POLL_MS = 250;
const STOP_GRACE_MS = 5_000;

export type StopApp = () => Promise<void>;

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    return res.status < 400;
  } catch {
    return false;
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // Negative pid: the whole process group setsid gave the command, so a dev
    // server's own children (vite, esbuild) go down with it.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run the config's start command and wait until its ready URL answers below
 * 400. The app's output goes to stderr so stdout stays the CLI's. Returns a stop
 * function; a command that exits early or never gets ready is a CaptureError.
 */
export async function startApp(start: StartCommand): Promise<StopApp> {
  const argv = ["sh", "-c", start.command];
  const proc = Bun.spawn(Bun.which("setsid") ? ["setsid", ...argv] : argv, {
    stdin: "ignore",
    stdout: 2,
    stderr: 2,
  });
  let exited = false;
  void proc.exited.then(() => {
    exited = true;
  });
  const stop: StopApp = async () => {
    if (exited) return;
    killGroup(proc.pid, "SIGTERM");
    const timer = setTimeout(() => killGroup(proc.pid, "SIGKILL"), STOP_GRACE_MS);
    await proc.exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + start.timeoutMs;
  while (Date.now() < deadline) {
    if (await answers(start.readyUrl)) return stop;
    if (exited)
      throw new CaptureError(
        `start command exited (code ${proc.exitCode}) before ${start.readyUrl} was ready`,
      );
    await Bun.sleep(POLL_MS);
  }
  await stop();
  throw new CaptureError(
    `${start.readyUrl} not ready within ${start.timeoutMs}ms of the start command`,
  );
}
