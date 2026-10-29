import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";

/**
 * A production build pointed at the GitHub stand-in does not start (PS-250): the stand-in lets
 * anyone sign in as anyone, so only `vite dev` and the `CLOUDFLARE_ENV=e2e` build may use it. This
 * builds the Worker as a stranger's deployment would (no `CLOUDFLARE_ENV`), then loads it in
 * workerd once with the stand-in's bases and once with GitHub's. The second load is also the
 * deployment with no Google client (PS-274): no Google button, and `/auth/google` is a 404.
 */

const WEB_ROOT = resolve(import.meta.dirname, "..");
const OUT = join(WEB_ROOT, ".wrangler/stub-refusal");
// `vite build` points `wrangler deploy` at the build it just made; this one is thrown away.
const DEPLOY_REDIRECT = join(WEB_ROOT, ".wrangler/deploy/config.json");

type BuiltConfig = {
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
};

function modules(dir: string, main: string) {
  const found: { type: "ESModule" | "CompiledWasm"; path: string }[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (relative(dir, path) === main) continue;
      else if (/\.m?js$/.test(name)) found.push({ type: "ESModule", path: relative(dir, path) });
      else if (name.endsWith(".wasm"))
        found.push({ type: "CompiledWasm", path: relative(dir, path) });
    }
  };
  walk(dir);
  return [{ type: "ESModule" as const, path: main }, ...found];
}

type Page = { status: number; body: string };

/**
 * Load the built Worker with these GitHub bases: `why` is null when it starts, else why it did not;
 * `pages` is what it answered at each of `paths`.
 */
async function start(
  bases: { GITHUB_OAUTH_BASE: string; GITHUB_API_BASE: string },
  paths: string[] = [],
): Promise<{ why: string | null; pages: Record<string, Page> }> {
  const serverDir = join(OUT, "server");
  const config: BuiltConfig = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
  const logged: string[] = [];
  const log = new (class extends Log {
    override logWithLevel(_level: LogLevel, message: string) {
      logged.push(message);
    }
  })(LogLevel.ERROR);
  const mf = new Miniflare({
    ...convertV4MiniflareOptions({
      workers: [
        {
          name: "pixelslash-web",
          modulesRoot: serverDir,
          modules: modules(serverDir, config.main).map((m) => ({
            ...m,
            path: join(serverDir, m.path),
          })),
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags ?? [],
          bindings: { ...config.vars, ...bases },
        },
      ],
    }),
    log,
  });
  const pages: Record<string, Page> = {};
  try {
    await mf.ready;
    const res = await mf.dispatchFetch("http://localhost/");
    await res.arrayBuffer();
    if (res.status >= 500) return { why: `answered ${res.status}: ${logged.join("\n")}`, pages };
    for (const path of paths) {
      const page = await mf.dispatchFetch(`http://localhost${path}`, { redirect: "manual" });
      pages[path] = { status: page.status, body: await page.text() };
    }
    return { why: null, pages };
  } catch (e) {
    return { why: `${e instanceof Error ? e.message : String(e)}\n${logged.join("\n")}`, pages };
  } finally {
    await mf.dispose().catch(() => {});
  }
}

test.describe("a production build and the GitHub stand-in", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const redirect = existsSync(DEPLOY_REDIRECT) ? readFileSync(DEPLOY_REDIRECT) : null;
    const env = { ...process.env };
    delete env["CLOUDFLARE_ENV"];
    delete env["PIXELSLASH_E2E"];
    try {
      const built = spawnSync("bunx", ["vite", "build", "--outDir", OUT], {
        cwd: WEB_ROOT,
        env,
        encoding: "utf8",
      });
      expect(built.status, built.stderr || built.stdout).toBe(0);
    } finally {
      if (redirect) writeFileSync(DEPLOY_REDIRECT, redirect);
      else rmSync(DEPLOY_REDIRECT, { force: true });
    }
  });

  test.afterAll(() => rmSync(OUT, { recursive: true, force: true }));

  test("pointed at the stand-in, it does not start, and says why", async () => {
    const stub = "http://localhost:4174";
    const { why } = await start({ GITHUB_OAUTH_BASE: stub, GITHUB_API_BASE: stub });
    expect(why).toContain("refusing to start: GITHUB_OAUTH_BASE is http://localhost:4174");
  });

  test("pointed at GitHub, the same build starts; with no Google client, no Google sign-in", async () => {
    const { why, pages } = await start(
      { GITHUB_OAUTH_BASE: "https://github.com", GITHUB_API_BASE: "https://api.github.com" },
      ["/", "/auth/google", "/auth/google/callback"],
    );
    expect(why).toBeNull();
    expect(pages["/"]?.body).toContain("Sign in with GitHub");
    expect(pages["/"]?.body).not.toContain("Sign in with Google");
    expect(pages["/auth/google"]?.status).toBe(404);
    expect(pages["/auth/google/callback"]?.status).toBe(404);
  });
});
