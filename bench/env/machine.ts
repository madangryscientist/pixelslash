/**
 * The machine as the helper sees it: the seam a test replaces, the one unit the helper manages, and the one
 * way it reaches systemd. A leaf module, so the restore half (`./restore.ts`) can use them without importing
 * `./reserve.ts`, which imports it.
 */

/** The transient unit the runner's process tree lives in. */
export const SCOPE = "pixelslash-bench.scope";

export type Out = { code: number; out: string; err: string };

/** Everything the helper does to the machine. */
export type Host = {
  exec(cmd: string[]): Promise<Out>;
  /** The file's text, or null when it is not there. */
  read(path: string): string | null;
  write(path: string, text: string): void;
  /** Create `path` only if it does not exist; false when it does. */
  create(path: string, text: string): boolean;
  remove(path: string): void;
  mkdir(path: string): void;
  /** Owner of the process, or null when there is no such process. */
  procUid(pid: number): number | null;
  /** The user who ran sudo, or null when not run through sudo. */
  callerUid: number | null;
  /** This helper's own process id. */
  self: number;
  /** Whether this process is itself inside the scope (the runner called it from there). */
  insideScope(): boolean;
  /** Epoch milliseconds. */
  now(): number;
  /** Absolute path of this helper's own binary: what the lapse timer runs. */
  selfPath: string;
};

/** One `systemctl` call, which throws on a non-zero exit. */
export async function systemctl(host: Host, args: string[]): Promise<void> {
  const r = await host.exec(["systemctl", ...args]);
  if (r.code !== 0) throw new Error(`systemctl ${args.join(" ")}: ${r.err.trim() || r.code}`);
}
