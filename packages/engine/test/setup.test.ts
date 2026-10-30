import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { parseConfig, loadConfig } from "../src/config.ts";
import { CaptureError, UsageError } from "../src/errors.ts";
import { captureSnapshots } from "../src/snapshot.ts";

/** The session cookie's value: it must not turn up anywhere in the snapshot dir. */
const SECRET = "s3cret-session-7f2a";
const page = (body: string, colour: string) =>
  new Response(
    `<!doctype html><html><body style="margin:0;background:${colour}">${body}</body></html>`,
    { headers: { "content-type": "text/html" } },
  );

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/login" && req.method === "POST") {
      const form = await req.formData();
      if (form.get("user") !== "ada") return new Response("no", { status: 403 });
      return new Response(null, {
        status: 303,
        headers: { location: "/private", "set-cookie": `session=${SECRET}; Path=/; HttpOnly` },
      });
    }
    if (url.pathname === "/login")
      return page('<form method="post"><input name="user"><button>Sign in</button></form>', "#fff");
    if (url.pathname === "/private") {
      if (req.headers.get("cookie")?.includes(`session=${SECRET}`))
        return page("<h1>Signed in</h1>", "rgb(22, 163, 74)");
      return new Response("sign in first", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  },
});

const dirs: string[] = [];
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-setup-"));
  dirs.push(dir);
  return dir;
}

/** Write a setup module into a temp dir; its path. */
async function setupFile(source: string): Promise<string> {
  const path = join(await tmp(), "setup.mjs");
  await Bun.write(path, source);
  return path;
}

const SIGN_IN_FORM = `export default async ({ page }) => {
  await page.goto("/login");
  await page.fill("input[name=user]", "ada");
  await page.click("button");
  await page.waitForURL(/\\/private/);
};`;

const configWith = (setup: string | undefined) =>
  parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [{ path: "/private", name: "private" }],
    variants: [{ name: "desktop", viewport: { width: 400, height: 200 } }],
    ...(setup && { setup }),
  });

const pinned = { env: { PIXELSLASH_IMAGE_VERSION: "test" }, listFonts: async () => [] };

/** Every byte the snapshot dir holds, as one string. */
async function everything(dir: string): Promise<string> {
  const files = await readdir(dir, { recursive: true });
  const parts = await Promise.all(
    files.map(async (f) => {
      const file = Bun.file(join(dir, f));
      return (await file.exists()) ? Buffer.from(await file.bytes()).toString("latin1") : "";
    }),
  );
  return parts.join("\n");
}

/** Capture /private with `setup`; the first pixel and everything the snapshot dir holds. */
async function signedInShot(
  setup: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ rgba: number[]; written: string }> {
  const out = await tmp();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    await captureSnapshots(configWith(setup), out, pinned);
  } finally {
    process.env = saved;
  }
  const img = PNG.sync.read(Buffer.from(await Bun.file(join(out, "private/desktop.png")).bytes()));
  return { rgba: Array.from(img.data.subarray(0, 4)), written: await everything(out) };
}

const SIGNED_IN = [22, 163, 74, 255];

describe("setup", () => {
  test("without one, a page behind sign-in fails the capture", async () => {
    await expect(captureSnapshots(configWith(undefined), await tmp(), pinned)).rejects.toThrow(
      /HTTP 401/,
    );
  }, 60_000);

  test("signs in through a form once, every shot gets the session, and no secret is written", async () => {
    const { rgba, written } = await signedInShot(await setupFile(SIGN_IN_FORM));
    expect(rgba).toEqual(SIGNED_IN);
    expect(written).not.toContain(SECRET);
  }, 60_000);

  test("reuses a saved session: cookies from a file named in env", async () => {
    const session = join(await tmp(), "session.json");
    await Bun.write(
      session,
      JSON.stringify({
        cookies: [{ name: "session", value: SECRET, url: `http://127.0.0.1:${server.port}` }],
      }),
    );
    const setup = await setupFile(`export default async ({ context }) => {
  const { cookies } = JSON.parse(await Bun.file(process.env.TEST_SESSION_FILE).text());
  await context.addCookies(cookies);
};`);
    const { rgba, written } = await signedInShot(setup, { TEST_SESSION_FILE: session });
    expect(rgba).toEqual(SIGNED_IN);
    expect(written).not.toContain(SECRET);
  }, 60_000);

  test("a setup that throws fails the capture by its path; one with no function is a usage error", async () => {
    const throws = await setupFile(
      'export default async () => { throw new Error("bad password"); };',
    );
    const run = captureSnapshots(configWith(throws), await tmp(), pinned);
    await expect(run).rejects.toBeInstanceOf(CaptureError);
    await expect(run).rejects.toThrow(`setup ${throws} failed: bad password`);

    const notAFunction = await setupFile("export default 42;");
    await expect(
      captureSnapshots(configWith(notAFunction), await tmp(), pinned),
    ).rejects.toBeInstanceOf(UsageError);
  }, 60_000);

  test("loadConfig reads a relative setup against the config's own dir", async () => {
    const dir = await tmp();
    await Bun.write(
      join(dir, "pixelslash.config.json"),
      JSON.stringify({ baseUrl: "http://127.0.0.1:1", routes: ["/"], setup: "auth/sign-in.ts" }),
    );
    expect((await loadConfig(join(dir, "pixelslash.config.json"))).setup).toBe(
      join(dir, "auth/sign-in.ts"),
    );
    expect(() => parseConfig({ baseUrl: "http://x", routes: ["/"], setup: "" })).toThrow(
      "config: setup must be a non-empty string",
    );
  });
});
