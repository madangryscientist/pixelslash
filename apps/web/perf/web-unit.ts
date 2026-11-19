/**
 * A local web unit shaped like the LAN self-host's `pixelslash-web` (PS-464): the e2e build served
 * by `deploy/ssh/serve.ts` in a `systemd-run --user` unit, over a fresh `.wrangler/state` seeded
 * with projects and CI tokens, and a client that speaks the CLI's protocol. `web-burst.ts` and
 * `wedge-check.ts` drive it. On demand, on a development machine, never against the review server.
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Client as Api, isObj, send } from "../../../packages/engine/src/upload-client";
import { type Shot, form } from "./corpus";

export const WEB = resolve(import.meta.dirname, "..");
const STATE = join(WEB, ".wrangler/state");

export const say = (line: string) =>
  process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
const run = (...cmd: string[]) =>
  spawnSync(cmd[0] ?? "", cmd.slice(1), { cwd: WEB, encoding: "utf8" });
export const hex = () => randomBytes(20).toString("hex");

function mustRun(...cmd: string[]): void {
  const done = run(...cmd);
  if (done.status !== 0) throw new Error(`${cmd.join(" ")}: ${done.stdout}${done.stderr}`);
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

type Project = { id: string; token: string };

export const project = (name: string): Project => ({
  id: `load-${name}`,
  token: `psci_${randomBytes(24).toString("hex")}`,
});

/** Migrate the fresh state's D1 and add one synthetic org holding `projects`, each with a CI token. */
function seed(projects: Project[]): void {
  const scratch = mkdtempSync(join(tmpdir(), "ps-web-unit-"));
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

export type WebUnit = {
  unit: string;
  port: number;
  server: string;
  /** systemd properties beside the restart ones, e.g. `MemoryMax=4000M`. */
  limits: string[];
};

export const unitShow = (unit: string, prop: string) =>
  run("systemctl", "--user", "show", unit, "-p", prop, "--value").stdout.trim();

export function stopUnit(unit: string): void {
  run("systemctl", "--user", "stop", unit);
  run("systemctl", "--user", "reset-failed", unit);
}

/**
 * A fresh state (deleted only with `fresh`), the seeded projects, and the unit started on the
 * shipped unit's restart policy with `limits`. Returns when `GET /` answers.
 */
export async function startWebUnit(
  web: WebUnit,
  projects: Project[],
  { fresh }: { fresh: boolean },
): Promise<void> {
  if (!existsSync(join(WEB, "dist/server/wrangler.json")))
    throw new Error("no build: run CLOUDFLARE_ENV=e2e bun run build in apps/web first");
  stopUnit(web.unit);
  if (existsSync(STATE)) {
    if (!fresh)
      throw new Error(`${STATE} exists: pass --fresh 1 to delete it, or move it out of the way`);
    rmSync(STATE, { recursive: true, force: true });
  }
  if (await portBusy(web.port)) throw new Error(`port ${web.port} is already in use`);
  seed(projects);
  const properties = [...web.limits, "OOMPolicy=stop", "Restart=on-failure", "RestartSec=2"];
  mustRun(
    "systemd-run",
    "--user",
    "--quiet",
    `--unit=${web.unit}`,
    `--working-directory=${WEB}`,
    ...properties.flatMap((p) => ["-p", p]),
    "-E",
    "HOST=127.0.0.1",
    "-E",
    `PORT=${web.port}`,
    "-E",
    `PATH=${process.env["PATH"] ?? ""}`,
    process.execPath,
    "deploy/ssh/serve.ts",
  );
  await waitUp(web);
}

export async function answers(server: string, ms: number): Promise<boolean> {
  try {
    await (await fetch(`${server}/`, { signal: AbortSignal.timeout(ms) })).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function waitUp(web: WebUnit): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await answers(web.server, 3000)) return;
    await Bun.sleep(500);
  }
  throw new Error(`${web.server} did not come up: journalctl --user -u ${web.unit}`);
}

const cgroupOf = (unit: string) => `/sys/fs/cgroup${unitShow(unit, "ControlGroup")}`;

export function memoryEvents(unit: string): Record<string, number> {
  const file = `${cgroupOf(unit)}/memory.events`;
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" "))
      .map(([key, value]) => [key ?? "", Number(value)]),
  );
}

/** The cgroup's anon bytes and page cache now, in MiB: the peak counts the local R2 files' cache too. */
const mib = (n: number) => Math.round(n / 1048576);

export function memoryNow(unit: string): { currentMB: number; anonMB: number; fileMB: number } {
  const dir = cgroupOf(unit);
  if (!existsSync(`${dir}/memory.stat`)) return { currentMB: 0, anonMB: 0, fileMB: 0 };
  const stat = readFileSync(`${dir}/memory.stat`, "utf8");
  const field = (name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(stat)?.[1] ?? 0);
  return {
    currentMB: mib(Number(readFileSync(`${dir}/memory.current`, "utf8"))),
    anonMB: mib(field("anon")),
    fileMB: mib(field("file")),
  };
}

export function unitFacts(unit: string) {
  const { max, oom_kill: oomKill } = memoryEvents(unit);
  return {
    active: unitShow(unit, "ActiveState"),
    result: unitShow(unit, "Result"),
    restarts: Number(unitShow(unit, "NRestarts")),
    peakMB: Math.round(Number(unitShow(unit, "MemoryPeak")) / 1048576),
    maxEvents: max ?? 0,
    oomKills: oomKill ?? 0,
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
  const shots = db
    .query<{ s: string | null; e: string | null }, [string]>(
      "SELECT diff_status AS s, diff_error AS e FROM snapshots WHERE build_id = ?",
    )
    .all(id);
  return {
    status: build.status,
    error: build.error,
    shots: shots.length,
    changed: shots.filter((row) => row.s === "changed").length,
    errored: shots.filter((row) => row.e !== null).length,
  };
}

export type Finalise = { ms: number; status: string; unmeasured: number | null };

/** One uploader: the CLI's protocol (`packages/engine/src/upload.ts`) over the engine's own `send`. */
export class Client {
  private readonly api: Api;
  constructor(
    server: string,
    private readonly owner: Project,
    private readonly concurrency = 4,
  ) {
    this.api = { fetch, base: server, token: owner.token, sleep: Bun.sleep, warn: say };
  }

  async open(body: object): Promise<string> {
    const reply = await send(this.api, {
      step: "open build",
      method: "POST",
      path: "/api/v1/builds",
      body: JSON.stringify({ ...body, projectId: this.owner.id, clientDiff: true }),
    });
    if (!isObj(reply) || typeof reply["id"] !== "string") throw new Error("open build: no id");
    return reply["id"];
  }

  async putAll(id: string, list: Shot[]): Promise<void> {
    const queue = [...list];
    const worker = async () => {
      for (let shot = queue.shift(); shot; shot = queue.shift())
        await send(this.api, {
          step: `upload ${shot.name}`,
          method: "PUT",
          path: `/api/v1/builds/${id}/snapshots`,
          body: form(shot),
        });
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
  }

  /** Finalise again only while the count left falls, as the CLI does. */
  async finalise(id: string, count: number): Promise<Finalise[]> {
    const rounds: Finalise[] = [];
    let left = Infinity;
    for (;;) {
      const started = Date.now();
      const reply = await send(this.api, {
        step: "finalize",
        method: "POST",
        path: `/api/v1/builds/${id}/finalize`,
        body: JSON.stringify({ snapshots: count }),
      });
      if (!isObj(reply) || typeof reply["status"] !== "string")
        throw new Error("finalize: no status");
      const now = typeof reply["unmeasured"] === "number" ? reply["unmeasured"] : null;
      rounds.push({ ms: Date.now() - started, status: reply["status"], unmeasured: now });
      if (reply["status"] !== "errored" || now === null || now <= 0 || now >= left) return rounds;
      left = now;
    }
  }
}
