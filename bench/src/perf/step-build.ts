/**
 * The end-to-end server step (ob 1790): the web app as the Playwright e2e starts it (a production
 * build previewed on a fresh local D1, signing in against a GitHub stub), a small build uploaded
 * the way the CLI does, timed from opening the build to the verdict that finalising returns.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { BUILD_SHOTS, BUILD_SIZE, branchFile, buildShotName, mainFile } from "./fixtures.ts";
import { run } from "./worktree.ts";

const WARMUP = 1;
const ITERATIONS = 3;
const SHA_MAIN = "a".repeat(40);

type Proc = ReturnType<typeof Bun.spawn>;

/** The stub and the preview that are up; a signal to the probe ends them (`stopLive`). */
const live = new Set<Proc>();

export async function stopLive(): Promise<void> {
  await Promise.all([...live].map(stop));
}

/** Where the web app lives in a tree, and the env its build, migrations and preview share. */
function webEnv(stubPort: number, tmp: string): Record<string, string> {
  return {
    PIXELSLASH_E2E: "1",
    CLOUDFLARE_ENV: "e2e",
    PIXELSLASH_E2E_STUB_PORT: String(stubPort),
    TMPDIR: tmp,
  };
}

const webDir = (tree: string): string => join(tree, "apps/web");

/** `vite build` of the tree's web app, with the e2e env. Run once per tree, before any round. */
export async function buildWeb(tree: string, stubPort: number): Promise<void> {
  const cwd = webDir(tree);
  const tmp = join(cwd, ".wrangler/e2e/tmp");
  mkdirSync(tmp, { recursive: true });
  const built = await run([join(cwd, "node_modules/.bin/vite"), "build"], cwd, {
    ...process.env,
    ...webEnv(stubPort, tmp),
  });
  if (built.code !== 0) throw new Error(`vite build failed in ${cwd}:\n${built.err.slice(-2000)}`);
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

function tail(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").slice(-1500) : "(no log)";
}

async function waitUp(url: string, proc: Proc, log: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`${url}: its process exited\n${tail(log)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(150);
  }
  throw new Error(`${url} did not come up in 120 s\n${tail(log)}`);
}

async function stop(proc: Proc): Promise<void> {
  live.delete(proc);
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const forced = setTimeout(() => proc.kill("SIGKILL"), 5000);
  await proc.exited;
  clearTimeout(forced);
}

type Servers = { origin: string; stop: () => Promise<void> };

/** A fresh local D1 and the GitHub stub, then the preview of the already built app. */
async function startServers(tree: string, stubPort: number): Promise<Servers> {
  const cwd = webDir(tree);
  const state = join(cwd, ".wrangler/e2e");
  rmSync(state, { recursive: true, force: true });
  const tmp = join(state, "tmp");
  mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, ...webEnv(stubPort, tmp) };
  const spawn = (cmd: string[], name: string, extra: Record<string, string> = {}) =>
    Bun.spawn(cmd, {
      cwd,
      env: { ...env, ...extra },
      stdout: Bun.file(join(tmp, `${name}.log`)),
      stderr: Bun.file(join(tmp, `${name}.log`)),
    });
  const started: Proc[] = [];
  try {
    const stub = spawn(["bun", "e2e/github-stub.ts"], "stub");
    started.push(stub);
    live.add(stub);
    await waitUp(`http://localhost:${stubPort}/health`, stub, join(tmp, "stub.log"));
    const migrate = spawn(
      [
        join(cwd, "node_modules/.bin/wrangler"),
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--env",
        "e2e",
        "--persist-to",
        ".wrangler/e2e",
      ],
      "migrate",
    );
    if ((await migrate.exited) !== 0)
      throw new Error(`migrations failed\n${tail(join(tmp, "migrate.log"))}`);
    const port = await freePort();
    const preview = spawn(
      [join(cwd, "node_modules/.bin/vite"), "preview", "--port", String(port), "--strictPort"],
      "preview",
    );
    started.push(preview);
    live.add(preview);
    const origin = `http://localhost:${port}`;
    await waitUp(origin, preview, join(tmp, "preview.log"));
    return { origin, stop: async () => void (await Promise.all(started.map(stop))) };
  } catch (e) {
    await Promise.all(started.map(stop));
    throw e;
  }
}

/**
 * Sign in through the stub, make an org and a project and issue a CI token, as the e2e's
 * `provision` in apps/web/e2e/api-upload.ts. Bench cannot import that (isolated linker), so a
 * change to those labels or reply shapes has to be made here too.
 */
async function provision(origin: string): Promise<string> {
  const browser = await chromium.launch({
    headless: true,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    const page = await browser.newPage({ baseURL: origin });
    page.setDefaultTimeout(30_000);
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in with GitHub" }).click();
    await page.waitForURL(/\/orgs$/);
    await page.getByRole("button", { name: "New organization", exact: true }).click();
    await page.getByLabel("New organization name").fill("Perf Co");
    await page.getByRole("button", { name: "Create organization" }).click();
    await page.getByRole("heading", { name: "Perf Co", exact: true }).waitFor();
    await page.getByRole("button", { name: "+ New project" }).first().click();
    await page.getByLabel("New project name").fill("perf");
    await page.getByRole("button", { name: "Create project" }).click();
    await page.getByRole("link", { name: "perf", exact: true }).waitFor();
    await page.getByRole("link", { name: "perf settings" }).click();
    await page.getByLabel("Token name, e.g. github-actions").fill("ci");
    await page.getByRole("button", { name: "Issue token" }).click();
    const issued = page.getByTestId("issued-token");
    await issued.waitFor();
    const token = (await issued.textContent()) ?? "";
    if (!token.startsWith("psci_")) throw new Error(`no CI token issued: ${token}`);
    return token;
  } finally {
    await browser.close();
  }
}

function shotForm(fixtures: string, file: (name: string) => string, name: string): FormData {
  const bytes = readFileSync(join(fixtures, file(name)));
  const { width, height } = BUILD_SIZE;
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify({
      name,
      platform: "linux",
      browser: "chromium",
      viewport: `${width}x${height}`,
      theme: "light",
      tags: ["web"],
      fingerprint: { image: "version:perf", browser: "chromium 1", fonts: "sha256:f" },
    }),
  );
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "shot.png");
  return form;
}

async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("the reply is not a JSON object");
  return Object.fromEntries(Object.entries(body));
}

/** Open a build, put every shot, finalise; the finalise reply is the verdict. Returns its status. */
async function uploadBuild(
  { origin, token }: { origin: string; token: string },
  build: object,
  shots: { dir: string; file: (name: string) => string },
): Promise<string> {
  const headers = { authorization: `Bearer ${token}` };
  const api = `${origin}/api/v1/builds`;
  const opened = await fetch(api, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(build),
  });
  if (opened.status !== 201)
    throw new Error(`open build: HTTP ${opened.status} ${await opened.text()}`);
  const { id } = await jsonObject(opened);
  if (typeof id !== "string") throw new Error("open build: the reply has no id");
  for (let i = 0; i < BUILD_SHOTS; i += 1) {
    const put = await fetch(`${api}/${id}/snapshots`, {
      method: "PUT",
      headers,
      body: shotForm(shots.dir, shots.file, buildShotName(i)),
    });
    if (put.status !== 200)
      throw new Error(`put shot ${i}: HTTP ${put.status} ${await put.text()}`);
  }
  const done = await fetch(`${api}/${id}/finalize`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ snapshots: BUILD_SHOTS }),
  });
  if (done.status !== 200) throw new Error(`finalize: HTTP ${done.status} ${await done.text()}`);
  const reply = await jsonObject(done);
  if (typeof reply["status"] !== "string") throw new Error("finalize: the reply has no status");
  if (reply["status"] === "errored")
    throw new Error(`the build errored: ${String(reply["error"])}`);
  return reply["status"];
}

/** Baseline build first (not timed), then the timed branch builds against it. */
export async function timeServerBuild(
  fixtures: string,
  tree: string,
  stubPort: number,
): Promise<number[]> {
  const servers = await startServers(tree, stubPort);
  try {
    const token = await provision(servers.origin);
    const auth = { origin: servers.origin, token };
    await uploadBuild(
      auth,
      { branch: "main", commitSha: SHA_MAIN },
      { dir: fixtures, file: mainFile },
    );
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i += 1) {
      const build = {
        branch: `work-${i}`,
        commitSha: String(i + 1).padStart(40, "b"),
        mergeBaseSha: SHA_MAIN,
        ancestorShas: [SHA_MAIN],
      };
      const started = performance.now();
      await uploadBuild(auth, build, { dir: fixtures, file: branchFile });
      if (i >= WARMUP) samples.push(performance.now() - started);
    }
    return samples;
  } finally {
    await servers.stop();
  }
}
