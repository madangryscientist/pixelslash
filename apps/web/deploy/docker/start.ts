/**
 * The Docker self-host's entrypoint (PS-240): one container that runs the review app and the diff
 * worker, with every byte of state under one volume. See apps/web/README.md, "Self-host in 5
 * minutes", and docker/self-host/compose.yaml.
 *
 * - The app is the production build (`bun run build`, so the stub guard of PS-250 holds) on
 *   Miniflare, through `deploy/ssh/serve.ts`'s options, as on the LAN self-host. Its `Db` is D1,
 *   which Miniflare keeps as a SQLite file, and its `orgBlobs` store is R2, which Miniflare keeps as
 *   files: both under `$PIXELSLASH_DATA_DIR/state` (default `/data/state`), so a restart keeps them.
 * - The migrations run before the app listens (`migrate.ts`), on a D1-only Miniflare over the same
 *   files, so no request reaches a schema that is not there yet.
 * - The diff worker is `deploy/ssh/diff-sidecar.ts` on 127.0.0.1:4181 (`PIXELSLASH_DIFF_SIDECAR_PORT`),
 *   started here and started again if it exits. The Worker measures in-process while it is down.
 * - Nothing is fetched from Cloudflare: `cf: false` gives requests Miniflare's placeholder
 *   `request.cf` instead of downloading one from workers.cloudflare.com at start.
 * - Config comes from the container's environment: any name the build's `vars` has, and the
 *   secrets. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are required. `IMAGE_SIGNING_SECRET` and
 *   `MODEL_KEY_SECRET` are generated once into `$PIXELSLASH_DATA_DIR/secrets` (mode 600) when the
 *   environment does not set them, so a restart does not break signed URLs or sealed model keys.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { miniflareOptions, readConfig } from "../ssh/serve.ts";
import { applyMigrations } from "./migrate.ts";

const WEB_ROOT = resolve(import.meta.dirname, "../..");
const DATA_DIR = process.env["PIXELSLASH_DATA_DIR"] || "/data";
/** `wrangler d1 ... --local --persist-to $DATA_DIR/state` reads the same files. */
const PERSIST_ROOT = join(DATA_DIR, "state/v3");
const TMP_PATH = join(DATA_DIR, "tmp");
const SECRETS_DIR = join(DATA_DIR, "secrets");
const SIDECAR_PORT = Number(process.env["PIXELSLASH_DIFF_SIDECAR_PORT"] || 4181);

/** Bindings that are secrets on Cloudflare, so the build's `vars` does not name them all. */
const SECRET_NAMES = [
  "GITHUB_CLIENT_SECRET",
  "IMAGE_SIGNING_SECRET",
  "MODEL_KEY_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "SENTRY_DSN",
];

/** What a self-host means where the build's `vars` mean Cloudflare; the environment still wins. */
const SELF_HOST_DEFAULTS: Record<string, string> = {
  DEFAULT_DIFF_LOCATION: "server",
  DIFF_SIDECAR_URL: `http://127.0.0.1:${SIDECAR_PORT}`,
  SENTRY_ENVIRONMENT: "self-host",
};

/** Generated once and kept on the volume; how each is made matches apps/web/README.md, "Secrets". */
const GENERATED: Record<string, () => string> = {
  IMAGE_SIGNING_SECRET: () => randomBytes(32).toString("hex"),
  MODEL_KEY_SECRET: () => randomBytes(32).toString("base64"),
};

const log = (line: string) => process.stdout.write(`${line}\n`);

function keptSecret(name: string, make: () => string): string {
  const path = join(SECRETS_DIR, name);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const value = make();
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  log(`generated ${name} into ${path}`);
  return value;
}

/** The build's vars overlaid by the self-host's defaults, the environment and the kept secrets. */
export function bindingsFrom(
  env: Record<string, string | undefined>,
  varNames: string[],
  kept: (name: string, make: () => string) => string,
): Record<string, string> {
  const bindings: Record<string, string> = { ...SELF_HOST_DEFAULTS };
  for (const name of [...varNames, ...SECRET_NAMES]) {
    const value = env[name];
    if (value !== undefined && value !== "") bindings[name] = value;
  }
  for (const [name, make] of Object.entries(GENERATED)) bindings[name] ??= kept(name, make);
  return bindings;
}

/** Why the container cannot start with these bindings, or null. */
export function missingConfig(bindings: Record<string, string>): string | null {
  const missing = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"].filter((n) => !bindings[n]);
  if (missing.length === 0) return null;
  return (
    `${missing.join(" and ")} must be set: create a GitHub OAuth app with the callback ` +
    "<your URL>/auth/github/callback and put its id and secret in docker/self-host/.env"
  );
}

async function migrate(config: ReturnType<typeof readConfig>): Promise<void> {
  const d1 = config.d1_databases?.[0];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.WARN),
      telemetry: { enabled: false },
      cf: false,
      resourcePersistencePath: PERSIST_ROOT,
      resourceTmpPath: TMP_PATH,
      workers: [
        {
          name: "pixelslash-web",
          modules: true,
          script: "export default {}",
          compatibilityDate: config.compatibility_date,
          d1Databases: { DB: { id: d1?.["database_id"] ?? "" } },
        },
      ],
    }),
  );
  try {
    const applied = await applyMigrations(await mf.getD1Database("DB"), join(WEB_ROOT, "drizzle"));
    log(applied.length ? `migrated: ${applied.join(", ")}` : "migrations: none pending");
  } finally {
    await mf.dispose();
  }
}

/** The diff worker, started again two seconds after it exits until the container stops. */
function startSidecar(stopping: () => boolean): void {
  const child = Bun.spawn(["bun", "deploy/ssh/diff-sidecar.ts"], {
    cwd: WEB_ROOT,
    env: { ...process.env, PIXELSLASH_DIFF_SIDECAR_PORT: String(SIDECAR_PORT) },
    stdout: "inherit",
    stderr: "inherit",
  });
  void child.exited.then((code) => {
    if (stopping()) return;
    log(`diff sidecar exited (${code}); starting it again in 2 s`);
    setTimeout(() => startSidecar(stopping), 2000);
  });
}

if (import.meta.main) {
  const config = readConfig();
  const bindings = bindingsFrom(process.env, Object.keys(config.vars ?? {}), keptSecret);
  const refusal = missingConfig(bindings);
  if (refusal) {
    process.stderr.write(`pixelslash: ${refusal}\n`);
    process.exit(1);
  }
  mkdirSync(TMP_PATH, { recursive: true });
  await migrate(config);
  let stopping = false;
  startSidecar(() => stopping);
  const mf = new Miniflare({
    ...miniflareOptions({ persistRoot: PERSIST_ROOT, tmpPath: TMP_PATH, bindings }),
    cf: false,
  });
  const stop = () => {
    stopping = true;
    void mf.dispose().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const url = await mf.ready;
  log(`pixelslash self-host serving on ${url.href} (data in ${DATA_DIR})`);
}
