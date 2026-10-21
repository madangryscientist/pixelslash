/**
 * Dogfood: shoot the organizations page with PixelSlash's own snapshot format, so the review app
 * can review a change to itself (ob 1707). Run by hand, not in the gate:
 *
 *   bun e2e/dogfood-orgs.ts --out <snapshot dir>      (from apps/web)
 *
 * It builds the app, starts it on a fresh local D1 behind the GitHub stand-in, signs in through
 * it, seeds fixed rows, and shoots 1280 wide into `<out>/manifest.json` + PNGs, the layout
 * `pixelslash capture` writes. Upload the dir with `pixelslash upload`.
 *
 * It shares `.wrangler/e2e` and `dist/` with the e2e suite (vite.config pins the persist path), so
 * do not run it while `nx test:e2e web` runs.
 *
 * Deterministic: fixed ids, dates and ports (the empty state prints the server URL), animations
 * off, and every relative time ("3h ago") overwritten with a fixed string. Two runs of one
 * commit diff to zero. Only the sign-in, `/orgs?org=<id>` and the page's own buttons are used,
 * so the same script shoots an older commit, whatever it renders.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, chromium } from "@playwright/test";
import { seedSql } from "./dogfood-seed";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env["PIXELSLASH_DOGFOOD_PORT"] ?? 4310);
const STUB_PORT = PORT + 1;
const SERVER = `http://localhost:${PORT}`;
const STUB = `http://localhost:${STUB_PORT}`;
const PERSIST = ".wrangler/e2e";
const WIDTH = 1280;
const HEIGHT = 800;

function sh(cmd: string, env: Record<string, string> = {}) {
  execFileSync("sh", ["-c", cmd], {
    cwd: WEB,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
}

const SERVER_ENV = {
  PIXELSLASH_E2E: "1",
  CLOUDFLARE_ENV: "e2e",
  PIXELSLASH_E2E_PORT: String(PORT),
  PIXELSLASH_E2E_STUB_PORT: String(STUB_PORT),
  TMPDIR: join(WEB, PERSIST, "tmp"),
};

function start(cmd: string, env: Record<string, string>): ChildProcess {
  return spawn("sh", ["-c", cmd], {
    cwd: WEB,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
}

async function waitFor(url: string, what: string) {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`${what} did not come up at ${url}`);
}

/** Rows the page prints as "3h ago" depend on the clock; the shot gets a fixed string instead. */
async function steady(page: Page) {
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
  });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('[data-testid="rel-time"]'))
      el.textContent = "3d ago";
  });
}

async function hydrated(page: Page) {
  await page.waitForSelector('[data-hydrated="true"]');
  await page.evaluate(() => document.fonts.ready);
}

type Entry = {
  name: string;
  theme: "light" | "dark";
  url: string;
  act?: (page: Page) => Promise<void>;
};

const openDialog = async (page: Page) => {
  const button = page.getByRole("button", { name: "+ New project" }).first();
  if (await button.count()) {
    await button.click();
    await page.waitForTimeout(150);
  }
};

function entries(): Entry[] {
  const list: Entry[] = [];
  for (const theme of ["light", "dark"] as const) {
    list.push(
      { name: `orgs-projects@theme=${theme}`, theme, url: "/orgs?org=org-hackcove" },
      { name: `orgs-members@theme=${theme}`, theme, url: "/orgs?org=org-hackcove&tab=members" },
      { name: `orgs-empty@theme=${theme}`, theme, url: "/orgs?org=org-fresh" },
      {
        name: `orgs-new-project@theme=${theme}`,
        theme,
        url: "/orgs?org=org-hackcove",
        act: openDialog,
      },
    );
  }
  return list;
}

/** What `pixelslash capture` records as the fingerprint's `fonts`: every font file fontconfig lists. */
async function fonts(): Promise<string> {
  let listing = "";
  try {
    listing = execFileSync("fc-list", ["--format", "%{file}\\n"], { encoding: "utf8" });
  } catch {
    return "unknown";
  }
  const hash = createHash("sha256");
  for (const path of [...new Set(listing.split("\n").filter(Boolean))].toSorted()) {
    hash.update(`${path}\0`);
    hash.update(await readFile(path).catch(() => Buffer.alloc(0)));
  }
  return `sha256:${hash.digest("hex")}`;
}

async function shoot(out: string) {
  const browser = await chromium.launch();
  const fingerprint = {
    image: "bare",
    browser: `chromium ${browser.version()}`,
    fonts: await fonts(),
  };
  const manifest: unknown[] = [];

  const signedIn = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    baseURL: SERVER,
  });
  const page = await signedIn.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.waitForURL(/\/orgs/);
  await signedIn.close();

  const seed = join(WEB, PERSIST, "tmp", "seed.sql");
  await writeFile(seed, seedSql());
  sh(
    `bunx wrangler d1 execute DB --local --env e2e --persist-to ${PERSIST} --file ${seed} >/dev/null`,
  );

  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      baseURL: SERVER,
      colorScheme: theme,
      deviceScaleFactor: 1,
    });
    const shooter = await context.newPage();
    await shooter.goto("/");
    await shooter.getByRole("link", { name: "Sign in with GitHub" }).click();
    await shooter.waitForURL(/\/orgs/);
    for (const e of entries().filter((x) => x.theme === theme)) {
      await shooter.goto(e.url);
      await hydrated(shooter);
      if (theme === "dark" && !(await shooter.locator("html.dark").count())) {
        await shooter.getByTestId("theme-toggle").click();
        await shooter.waitForSelector("html.dark");
      }
      await e.act?.(shooter);
      await steady(shooter);
      const file = `${e.name.replace(/[@=]/g, "-")}/desktop.png`;
      await mkdir(join(out, dirname(file)), { recursive: true });
      await shooter.screenshot({ path: join(out, file), fullPage: !e.act });
      manifest.push({
        name: e.name,
        path: e.url,
        variant: {
          name: "desktop",
          browser: "chromium",
          viewport: { width: WIDTH, height: HEIGHT },
          theme,
        },
        tags: ["web", "orgs"],
        diff: {},
        ignore: [],
        file,
        fingerprint,
      });
    }
    await context.close();
  }
  await browser.close();
  await writeFile(
    join(out, "manifest.json"),
    `${JSON.stringify({ version: 1, snapshots: manifest }, null, 2)}\n`,
  );
}

async function main() {
  const flag = process.argv.indexOf("--out");
  const out = flag > 0 ? resolve(process.argv[flag + 1] ?? "") : "";
  if (!out || out === "/") throw new Error("usage: bun e2e/dogfood-orgs.ts --out <snapshot dir>");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  sh(`rm -rf ${PERSIST} && mkdir -p ${PERSIST}/tmp && bun run build`, SERVER_ENV);
  sh(
    `bunx wrangler d1 migrations apply DB --local --env e2e --persist-to ${PERSIST} >/dev/null`,
    SERVER_ENV,
  );
  const stub = start("bun e2e/github-stub.ts", SERVER_ENV);
  const app = start(`bunx vite preview --port ${PORT} --strictPort`, SERVER_ENV);
  const stop = () => {
    for (const child of [app, stub]) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  };
  try {
    await waitFor(`${STUB}/health`, "the GitHub stand-in");
    await waitFor(SERVER, "the app");
    await shoot(out);
  } finally {
    stop();
  }
  process.stdout.write(`${(await readdir(out)).length - 1} shots in ${out}\n`);
}

await main();
