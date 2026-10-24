/** The real `Host` of the reserve helper, and its entry point: `bun build --compile` makes the root binary (ob 1947). */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { HelperError, runHelper, SCOPE, type Host, type Out } from "./reserve.ts";

/** The only programs the helper runs, by absolute path: root must not resolve a name from the caller's PATH. */
const PROGRAMS: Record<string, string> = {
  systemctl: "/usr/bin/systemctl",
  busctl: "/usr/bin/busctl",
};

async function exec(cmd: string[]): Promise<Out> {
  const program = PROGRAMS[cmd[0] ?? ""];
  if (program === undefined) throw new Error(`not a command the helper runs: ${cmd[0] ?? ""}`);
  const proc = Bun.spawn([program, ...cmd.slice(1)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  // The helper ignores ^C so `on` and `off` finish; a systemd call that hangs must not make it unkillable.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out, err };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function procUid(pid: number): number | null {
  const status = readOrNull(`/proc/${pid}/status`);
  const real = /^Uid:\s+(\d+)/m.exec(status ?? "")?.[1];
  return real === undefined ? null : Number(real);
}

function sudoUid(): number | null {
  const raw = process.env["SUDO_UID"];
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : null;
}

export const realHost: Host = {
  exec,
  read: readOrNull,
  write: (path, text) => writeFileSync(path, text),
  create(path, text) {
    if (existsSync(path)) return false;
    try {
      writeFileSync(path, text, { flag: "wx", mode: 0o644 });
      return true;
    } catch (e) {
      if (e instanceof Error && Reflect.get(e, "code") === "EEXIST") return false;
      throw e;
    }
  },
  remove: (path) => rmSync(path, { force: true }),
  mkdir: (path) => void mkdirSync(path, { recursive: true, mode: 0o755 }),
  procUid,
  self: process.pid,
  callerUid: sudoUid(),
  insideScope: () => (readOrNull("/proc/self/cgroup") ?? "").includes(SCOPE),
};

if (import.meta.main) {
  // Root, run by sudo from the caller's directory: read no config from there (the build also turns
  // off the binary's bunfig and .env autoload), and let `on` and `off` finish if a ^C or a kill reaches them.
  process.chdir("/");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  let code = 0;
  try {
    process.stdout.write(`${await runHelper(realHost, process.argv.slice(2))}\n`);
  } catch (e) {
    code = e instanceof HelperError ? 2 : 1;
    process.stderr.write(
      `pixelslash-bench-reserve: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  process.exit(code);
}
