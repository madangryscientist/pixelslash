/**
 * The LAN self-host's web server (PS-220): the built Worker on Miniflare, with nothing in front of
 * workerd. It replaces `vite preview`, which was only the thing that started Miniflare through
 * `@cloudflare/vite-plugin` and sat at ~560 MB resident while it did (perf/README.md, PS-214).
 *
 * It serves `dist/server` (the Worker) and `dist/client` (static assets) of the `e2e` build, with
 * the same D1 and R2 state as `vite preview` kept: `.wrangler/state/v3`, the plugin's persist
 * directory, under the same database id and bucket name from `dist/server/wrangler.json`. The
 * build's `.dev.vars` (the deployment's own GitHub base, signing secret and model-key secret, which
 * `wrangler.jsonc`'s `env.e2e` does not hold) is laid over that file's `vars`.
 *
 * workerd listens on the port itself, so a request is never forwarded by a Node process: the
 * pooled connection `freshConnectionPerRequest` (ob 1876) had to reset sat in `dispatchFetch`,
 * which is not on the path here. See apps/web/README.md, "Run it on the Proxmox server".
 *
 * `PORT` (default 3000) and `HOST` (default 0.0.0.0) move it; the Rust front door (PS-217) will set
 * `HOST=127.0.0.1 PORT=3001`. The Docker self-host (PS-240, `deploy/docker/start.ts`) runs the same
 * options with its own state directory and bindings.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  LogLevel,
  Log,
  Miniflare,
  convertV4MiniflareOptions,
  type V4QueueConsumerOptions,
  type V4WorkerOptions,
} from "miniflare";

const WEB_ROOT = resolve(import.meta.dirname, "../..");
const SERVER_DIR = join(WEB_ROOT, "dist/server");
const CLIENT_DIR = join(WEB_ROOT, "dist/client");
/** The directory `@cloudflare/vite-plugin` persists to for a non-e2e run: `persistState: true`. */
const PERSIST_ROOT = join(WEB_ROOT, ".wrangler/state/v3");

type Binding = Record<string, string | undefined>;
/** The parts of the build's `wrangler.json` this reads. */
type BuiltConfig = {
  compatibility_date: string;
  compatibility_flags?: string[];
  main: string;
  vars?: Record<string, string>;
  d1_databases?: Binding[];
  r2_buckets?: Binding[];
  queues?: {
    producers?: { binding: string; queue: string }[];
    consumers?: {
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
    }[];
  };
};

type Module = { type: "ESModule" | "CompiledWasm"; path: string };

/**
 * The Worker's entry first, then every other module the build wrote beside it: wrangler's default
 * rules, so `.js` and `.mjs` are ES modules and `.wasm` (the engine's `diff.wasm`) is compiled.
 */
function moduleFiles(dir: string, main: string): Module[] {
  const found: Module[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (relative(dir, path) === main) continue;
      else if (name.endsWith(".js") || name.endsWith(".mjs"))
        found.push({ type: "ESModule", path: relative(dir, path) });
      else if (name.endsWith(".wasm"))
        found.push({ type: "CompiledWasm", path: relative(dir, path) });
    }
  };
  walk(dir);
  return [{ type: "ESModule", path: main }, ...found];
}

function toBindings(list: Binding[] | undefined, idKey: string): Record<string, { id: string }> {
  return Object.fromEntries(
    (list ?? []).map((entry) => [entry["binding"] ?? "", { id: entry[idKey] ?? "" }]),
  );
}

/** The build's `wrangler.json`, which `bun run build` writes beside the Worker. */
export function readConfig(): BuiltConfig {
  const configPath = join(SERVER_DIR, "wrangler.json");
  if (!existsSync(configPath))
    throw new Error(`${configPath} is missing: run CLOUDFLARE_ENV=e2e bun run build first`);
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function readDevVars(): Record<string, string> {
  const path = join(SERVER_DIR, ".dev.vars");
  if (!existsSync(path)) return {};
  const pairs = Object.entries(parseEnv(readFileSync(path, "utf8")));
  return Object.fromEntries(
    pairs.flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

function queueConsumers(config: BuiltConfig): Record<string, V4QueueConsumerOptions> {
  return Object.fromEntries(
    (config.queues?.consumers ?? []).map((c) => [
      c.queue,
      {
        ...(c.max_batch_size === undefined ? {} : { maxBatchSize: c.max_batch_size }),
        ...(c.max_batch_timeout === undefined ? {} : { maxBatchTimeout: c.max_batch_timeout }),
        ...(c.max_retries === undefined ? {} : { maxRetries: c.max_retries }),
      },
    ]),
  );
}

function workerOptions(config: BuiltConfig, overVars: Record<string, string>): V4WorkerOptions {
  const compatibilityFlags = config.compatibility_flags ?? [];
  return {
    name: "pixelslash-web",
    rootPath: SERVER_DIR,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags,
    modules: moduleFiles(SERVER_DIR, config.main),
    bindings: { ...config.vars, ...overVars },
    d1Databases: toBindings(config.d1_databases, "database_id"),
    r2Buckets: toBindings(config.r2_buckets, "bucket_name"),
    queueProducers: Object.fromEntries(
      (config.queues?.producers ?? []).map((p) => [p.binding, { queueName: p.queue }]),
    ),
    queueConsumers: queueConsumers(config),
    assets: {
      directory: CLIENT_DIR,
      routerConfig: { has_user_worker: true },
      assetConfig: {
        compatibility_date: config.compatibility_date,
        compatibility_flags: compatibilityFlags,
      },
    },
  };
}

/** Where D1 and R2 persist, and the values laid over the build's `vars`. */
type ServeOptions = {
  persistRoot: string;
  tmpPath: string;
  bindings: Record<string, string>;
};

export function miniflareOptions(
  options: ServeOptions = {
    persistRoot: PERSIST_ROOT,
    tmpPath: join(WEB_ROOT, ".wrangler/tmp"),
    bindings: readDevVars(),
  },
): ReturnType<typeof convertV4MiniflareOptions> {
  return convertV4MiniflareOptions({
    host: process.env["HOST"] ?? "0.0.0.0",
    port: Number(process.env["PORT"] ?? 3000),
    log: new Log(LogLevel.INFO),
    logRequests: false,
    telemetry: { enabled: false },
    resourcePersistencePath: options.persistRoot,
    resourceTmpPath: options.tmpPath,
    workers: [workerOptions(readConfig(), options.bindings)],
  });
}

if (import.meta.main) {
  const mf = new Miniflare(miniflareOptions());
  const stop = () => void mf.dispose().finally(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const url = await mf.ready;
  process.stdout.write(`pixelslash-web serving the built Worker on ${url.href}\n`);
}
