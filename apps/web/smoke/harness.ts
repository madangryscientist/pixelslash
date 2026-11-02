import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";

/**
 * The web smoke's server (PS-15): the production build, served by `vite preview` over a fresh
 * local D1 and R2 in `.wrangler/smoke`, and nothing else. No GitHub stand-in, no sidecar and no
 * error sink are started, and every URL the build can call out to points at a port nothing
 * listens on, so the run reaches no host but this machine.
 */
const WEB = fileURLToPath(new URL("..", import.meta.url));
export const STATE = ".wrangler/smoke";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function run(args: string[], env: Record<string, string>) {
  const done = spawnSync("bun", args, {
    cwd: WEB,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (done.status !== 0) throw new Error(`bun ${args.join(" ")}: ${done.stdout}${done.stderr}`);
}

export type Server = {
  url: string;
  /** Run statements against the server's D1 (wrangler, as the e2e does). */
  sql: (statements: string) => void;
  /** The D1 file, opened read-only, behind the Drizzle API the app's queries use. */
  db: () => ReturnType<typeof readDb>;
  stop: () => Promise<void>;
};

function readDb() {
  const dir = join(WEB, STATE, "v3/d1/miniflare-D1DatabaseObject");
  const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file) throw new Error(`no D1 file under ${dir}`);
  const sqlite = new DatabaseSync(join(dir, file), { readOnly: true });
  return drizzle(async (query, params, method) => {
    const stmt = sqlite.prepare(query);
    // Arrays, not objects: a join selecting two `id` columns must keep both.
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...params);
      return { rows: [] };
    }
    const rows = stmt.all(...params).map((r) => Object.values(r));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

async function waitUntilUp(child: ChildProcess, url: string) {
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || tries > 240) {
      child.kill("SIGTERM");
      throw new Error(`the smoke server did not come up; see ${join(STATE, "preview.log")}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startServer(): Promise<Server> {
  rmSync(join(WEB, STATE), { recursive: true, force: true });
  mkdirSync(join(WEB, STATE, "tmp"), { recursive: true });
  const [port, dead] = [await freePort(), await freePort()];
  const env = {
    PIXELSLASH_E2E: "1",
    CLOUDFLARE_ENV: "e2e",
    PIXELSLASH_E2E_STATE: STATE,
    // The build's outbound URLs, all on a closed loopback port; "" turns the diff sidecar off.
    PIXELSLASH_E2E_STUB_PORT: String(dead),
    PIXELSLASH_E2E_SIDECAR: "",
    TMPDIR: join(WEB, STATE, "tmp"),
  };
  run(["run", "build"], env);
  run(
    [
      "x",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--env",
      "e2e",
      "--persist-to",
      STATE,
    ],
    env,
  );
  const log = openSync(join(WEB, STATE, "preview.log"), "w");
  const child: ChildProcess = spawn(
    "bun",
    ["x", "vite", "preview", "--port", String(port), "--strictPort"],
    {
      cwd: WEB,
      env: { ...process.env, ...env },
      stdio: ["ignore", log, log],
    },
  );
  const url = `http://localhost:${port}`;
  await waitUntilUp(child, url);
  const scratch = mkdtempSync(join(tmpdir(), "ps-smoke-web-"));
  return {
    url,
    sql(statements) {
      const file = join(scratch, "seed.sql");
      writeFileSync(file, statements);
      run(
        [
          "x",
          "wrangler",
          "d1",
          "execute",
          "DB",
          "--local",
          "--env",
          "e2e",
          "--persist-to",
          STATE,
          "--file",
          file,
        ],
        env,
      );
    },
    db: readDb,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r(null)));
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
