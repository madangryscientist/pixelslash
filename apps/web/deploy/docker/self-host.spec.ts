import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { provision } from "../../e2e/api-upload";
import { png } from "../../e2e/png";
import { SERVER, SERVER_PORT, SIDECAR_PORT, STUB } from "../../e2e/ports";

/**
 * The Docker self-host (PS-240), end to end against the image: a fresh volume, sign-in through the
 * GitHub stand-in, a CLI upload that the container diffs, a restart, and the same rows and blobs
 * after it. The stand-in needs the `CLOUDFLARE_ENV=e2e` build (a production build refuses it,
 * PS-250), so the production image is checked separately: it sends sign-in to github.com.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const CLI = join(ROOT, "packages/cli/src/index.ts");
const RUN = `ps-self-host-e2e-${process.pid}`;
const WHITE = png(40, 40);
const CHANGED = png(40, 40, [{ x: 10, y: 10, w: 10, h: 10, rgb: [220, 30, 30] }]);
const MOVED = png(40, 40, [{ x: 20, y: 20, w: 10, h: 10, rgb: [30, 30, 220] }]);

function docker(...args: string[]): string {
  const res = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`docker ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

function build(tag: string, cloudflareEnv: string) {
  docker(
    "build",
    "-f",
    "docker/self-host/Dockerfile",
    "--build-arg",
    `CLOUDFLARE_ENV=${cloudflareEnv}`,
    "-t",
    tag,
    ".",
  );
}

/** Start a container on the host's network; returns its name. */
function start(name: string, image: string, env: Record<string, string>, volume?: string) {
  const flags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const mount = volume ? ["-v", `${volume}:/data`] : [];
  docker("run", "-d", "--name", name, "--network", "host", ...flags, ...mount, image);
  return name;
}

async function up(url: string) {
  await expect
    .poll(async () => (await fetch(url).catch(() => null))?.status ?? 0, { timeout: 120_000 })
    .toBe(200);
}

const temps: string[] = [];
const containers: string[] = [];
const volume = `${RUN}-data`;

test.afterAll(async () => {
  for (const name of containers) spawnSync("docker", ["rm", "-f", name]);
  spawnSync("docker", ["volume", "rm", "-f", volume]);
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

/** A snapshot dir as `capture` writes it, holding one 40×40 shot. */
async function snapshotDir(shot: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "ps-self-host-"));
  temps.push(dir);
  await mkdir(join(dir, "home"));
  await writeFile(join(dir, "home/desktop.png"), shot);
  const entry = {
    name: "home",
    path: "/",
    variant: {
      name: "desktop",
      browser: "chromium",
      viewport: { width: 40, height: 40 },
      theme: "light",
    },
    tags: ["web"],
    file: "home/desktop.png",
    fingerprint: { image: "version:e2e", browser: "chromium 1", fonts: "sha256:f" },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ version: 1, snapshots: [entry] }));
  return dir;
}

/** The real CLI uploads one shot; returns the build id it printed. */
async function upload(shot: Buffer, token: string): Promise<string> {
  const dir = await snapshotDir(shot);
  const res = spawnSync("bun", [CLI, "upload", dir, "--server", SERVER, "--branch", "e2e"], {
    cwd: ROOT,
    env: { ...process.env, PIXELSLASH_TOKEN: token },
    encoding: "utf8",
  });
  expect(res.status, res.stderr).toBe(0);
  return /build: (\S+)/.exec(res.stdout)?.[1] ?? "";
}

type Shot = { id: string; diff_status: string; diff_error: string | null; diff_result: unknown };

async function shotOf(buildId: string, token: string): Promise<Shot | undefined> {
  const res = await fetch(`${SERVER}/api/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const reply: { build: { snapshots: Shot[] } } = await res.json();
  return reply.build.snapshots[0];
}

test.describe.configure({ mode: "serial" });

test("signs in, takes an upload, diffs it, and keeps it all across a restart", async ({ page }) => {
  build("pixelslash-self-host:e2e", "e2e");
  const name = start(
    `${RUN}-app`,
    "pixelslash-self-host:e2e",
    {
      PORT: String(SERVER_PORT),
      PIXELSLASH_DIFF_SIDECAR_PORT: String(SIDECAR_PORT),
      GITHUB_CLIENT_ID: "e2e-client",
      GITHUB_CLIENT_SECRET: "e2e-secret",
      GITHUB_OAUTH_BASE: STUB,
      GITHUB_API_BASE: STUB,
    },
    volume,
  );
  containers.push(name);
  await up(SERVER);

  const { token } = await provision(page, "Self Co", "home");
  const first = await upload(WHITE, token);
  expect(await shotOf(first, token)).toMatchObject({ diff_status: "new" });
  const second = await upload(CHANGED, token);
  expect(await shotOf(second, token)).toMatchObject({
    diff_status: "changed",
    diff_error: null,
    diff_result: { changed_pixels: 100 },
  });
  // The diff worker is up inside the container.
  docker(
    "exec",
    name,
    "bun",
    "-e",
    `process.exit((await fetch("http://127.0.0.1:${SIDECAR_PORT}/health")).ok ? 0 : 1)`,
  );

  docker("restart", name);
  await up(SERVER);
  // The rows, the session and the token are where they were.
  expect(await shotOf(second, token)).toMatchObject({ diff_status: "changed" });
  await page.goto("/orgs");
  await expect(page.getByRole("heading", { name: "Self Co" })).toBeVisible();
  // The blobs are still on the volume: the shot's PNG is served, and a new upload diffs against
  // a baseline read back from disk.
  const read = await fetch(`${SERVER}/api/v1/snapshots/${(await shotOf(second, token))?.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { snapshot }: { snapshot: { images: { head: string } } } = await read.json();
  const head = await fetch(snapshot.images.head);
  expect(head.status).toBe(200);
  expect(Buffer.from(await head.arrayBuffer()).equals(CHANGED)).toBe(true);
  const third = await upload(MOVED, token);
  expect(await shotOf(third, token)).toMatchObject({ diff_status: "changed", diff_error: null });
});

test("the production image signs in through github.com", async () => {
  build("pixelslash-self-host:local", "");
  // The first container holds the port until it is gone.
  spawnSync("docker", ["rm", "-f", `${RUN}-app`]);
  const name = start(`${RUN}-prod`, "pixelslash-self-host:local", {
    PORT: String(SERVER_PORT),
    PIXELSLASH_DIFF_SIDECAR_PORT: String(SIDECAR_PORT),
    PIXELSLASH_DATA_DIR: "/tmp/data",
    GITHUB_CLIENT_ID: "self-host-client",
    GITHUB_CLIENT_SECRET: "unused",
  });
  containers.push(name);
  await up(SERVER);
  const res = await fetch(`${SERVER}/auth/github`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(location.searchParams.get("client_id")).toBe("self-host-client");
});
