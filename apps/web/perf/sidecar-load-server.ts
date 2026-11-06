/** PS-325's harness: its flags, and the server under test. `sidecar-load.ts` is the run. */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set((process.argv[i] ?? "").replace(/^--/, ""), process.argv[i + 1] ?? "");
const opt = (name: string, fallback: string) => args.get(name) ?? fallback;

export const UPLOADERS = Number(opt("uploaders", "3"));
export const SHOTS = Number(opt("shots", "20"));
/** Shots in one background build. */
export const BG_SHOTS = Number(opt("bg-shots", "4"));
export const SIZE = opt("size", "1280x16800");
/** `small`: main and branch differ by one block. `all`: every pixel differs, a diff's slowest case. */
export const CHANGE = opt("change", "all");
export const CONCURRENCY = Number(opt("concurrency", "4")); // the CLI's
export const PORT = Number(opt("port", "3325"));
export const SIDECAR_PORT = 4181; // the build's DIFF_SIDECAR_URL
export const OUT = opt("out", "");
/** Delete `.wrangler/state` first. Without it a run refuses to start on state it did not make. */
export const FRESH = opt("fresh", "0") === "1";

export const WEB = resolve(import.meta.dirname, "..");
export const STATE = join(WEB, ".wrangler/state");
export const SERVER = `http://127.0.0.1:${PORT}`;
export const WEB_UNIT = "ps-sidecar-load-web";
export const DIFF_UNIT = "ps-sidecar-load-diff";
export const TERMINAL_MISS_MS = 5000;
/** The CLI retries a failure the API never answered at these delays (`upload-client.ts`). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export const say = (line: string) =>
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
const run = (...cmd: string[]) =>
  spawnSync(cmd[0] ?? "", cmd.slice(1), { cwd: WEB, encoding: "utf8" });
export const hex = () => randomBytes(20).toString("hex");

function mustRun(...cmd: string[]): void {
  const done = run(...cmd);
  if (done.status !== 0) throw new Error(`${cmd.join(" ")}: ${done.stdout}${done.stderr}`);
}

export function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

export type Project = { id: string; token: string };

export function seed(projects: Project[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "ps-sidecar-load-"));
  const file = join(scratch, "seed.sql");
  const rows = projects.flatMap((p) => {
    const hash = createHash("sha256").update(p.token).digest("hex");
    return [
      `INSERT INTO projects (id, org_id, name, diff_location) VALUES ('${p.id}', 'load-org', '${p.id}', 'server');`,
      `INSERT INTO ci_tokens (id, project_id, name, token_hash, prefix, created_by) VALUES ('${p.id}-token', '${p.id}', 'load', '${hash}', '${p.token.slice(0, 9)}', 'load-user');`,
    ];
  });
  writeFileSync(
    file,
    [
      "INSERT INTO users (id, login) VALUES ('load-user', 'load-bot');",
      "INSERT INTO orgs (id, name, is_smoke) VALUES ('load-org', 'Load', 1);",
      "INSERT INTO members (org_id, user_id) VALUES ('load-org', 'load-user');",
      ...rows,
    ].join("\n"),
  );
  const d1 = ["bun", "x", "wrangler", "d1"];
  const where = ["--local", "--env", "e2e", "--persist-to", STATE];
  mustRun(...d1, "migrations", "apply", "DB", ...where);
  mustRun(...d1, "execute", "DB", ...where, "--file", file);
  rmSync(scratch, { recursive: true, force: true });
}

export function stopUnits(): void {
  for (const unit of [WEB_UNIT, DIFF_UNIT]) {
    run("systemctl", "--user", "stop", unit);
    run("systemctl", "--user", "reset-failed", unit);
  }
}

/** The shipped units' memory limits (`deploy/ssh/pixelslash-{web,diff}.service`). */
export function startUnit(unit: string, script: string, max: string, env: string[]): void {
  const properties = [`MemoryMax=${max}`, "MemorySwapMax=0", "OOMPolicy=stop"];
  mustRun(
    "systemd-run",
    "--user",
    "--quiet",
    `--unit=${unit}`,
    `--working-directory=${WEB}`,
    ...properties.flatMap((p) => ["-p", p]),
    ...env.flatMap((e) => ["-E", e]),
    "-E",
    `PATH=${process.env["PATH"] ?? ""}`,
    process.execPath,
    script,
  );
}

export async function waitUp(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SERVER}/`, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch {
      // Still starting.
    }
    await Bun.sleep(500);
  }
  throw new Error(`${SERVER} did not come up: journalctl --user -u ${WEB_UNIT}`);
}

const show = (unit: string, prop: string) =>
  run("systemctl", "--user", "show", unit, "-p", prop, "--value").stdout.trim();
export const journal = (unit: string, since: string) =>
  run("journalctl", "--user", "-u", unit, "--since", since, "-o", "cat", "--no-pager").stdout;

const MEMORY = new Map<string, { anon: number; file: number }>();

/** Peak heap against peak page cache: the cgroup's peak counts the local R2 files' cache too. */
export function sampleMemory(unit: string): void {
  const dir = `/sys/fs/cgroup${show(unit, "ControlGroup")}`;
  if (!existsSync(`${dir}/memory.stat`)) return;
  const stat = readFileSync(`${dir}/memory.stat`, "utf8");
  const field = (name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
  const peak = MEMORY.get(unit) ?? { anon: 0, file: 0 };
  MEMORY.set(unit, {
    anon: Math.max(peak.anon, field("anon")),
    file: Math.max(peak.file, field("file")),
  });
}

function memoryEvents(unit: string): Record<string, number> {
  const dir = `/sys/fs/cgroup${show(unit, "ControlGroup")}`;
  if (!existsSync(`${dir}/memory.events`)) return {}; // The unit died: `result` says so.
  const text = readFileSync(`${dir}/memory.events`, "utf8");
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .map(([key, value]) => [key ?? "", Number(value)]),
  );
}

export function unitFacts(unit: string) {
  const { max, oom_kill: oomKill } = memoryEvents(unit);
  return {
    active: show(unit, "ActiveState"),
    result: show(unit, "Result"),
    restarts: Number(show(unit, "NRestarts")),
    peakMB: Math.round(Number(show(unit, "MemoryPeak")) / 1048576),
    peakAnonMB: Math.round((MEMORY.get(unit)?.anon ?? 0) / 1048576),
    peakFileMB: Math.round((MEMORY.get(unit)?.file ?? 0) / 1048576),
    maxEvents: max ?? 0,
    oomKills: oomKill ?? 0,
  };
}

export function probeHome() {
  const times: Promise<number>[] = [];
  const timer = setInterval(() => {
    const t = Date.now();
    times.push(
      fetch(`${SERVER}/`, { signal: AbortSignal.timeout(30_000) })
        .then(async (res) => {
          await res.arrayBuffer();
          return res.ok ? Date.now() - t : -1;
        })
        .catch(() => -1),
    );
  }, 1000);
  return () => {
    clearInterval(timer);
    return Promise.all(times);
  };
}

export function openStateDb(): Database {
  const dir = join(STATE, "v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file) throw new Error(`no D1 file under ${dir}`);
  return new Database(join(dir, file), { readonly: true });
}

/** What the server stored for one build, not what its client was told. */
export function storedBuild(db: Database, id: string) {
  const build = db
    .query<{ status: string; error: string | null }, [string]>(
      "SELECT status, error FROM builds WHERE id = ?",
    )
    .get(id);
  if (!build) throw new Error(`no build ${id}`);
  const shotsOf = db
    .query<{ s: string | null; e: string | null; r: number }, [string]>(
      "SELECT diff_status AS s, diff_error AS e, rebaseline_needed AS r FROM snapshots WHERE build_id = ?",
    )
    .all(id);
  return {
    status: build.status,
    error: build.error,
    shots: shotsOf.length,
    measured: shotsOf.filter((row) => row.s !== null || row.r).length,
    errored: shotsOf.filter((row) => row.e !== null).length,
    unmeasured: shotsOf.filter((row) => row.s === null && !row.r).length,
  };
}
