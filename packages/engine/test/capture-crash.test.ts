import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { PNG } from "pngjs";
import { parseConfig } from "../src/config.ts";
import { CaptureError } from "../src/errors.ts";
import { captureSnapshots } from "../src/snapshot.ts";

/**
 * What a crashed page costs a capture (PS-332). The browser is the real one with `newContext`
 * counted, and `plan` says what each context's page does, so a test chooses the attempt that dies.
 */
let contexts = 0;
let plan: (n: number, context: BrowserContext) => void = () => {};

vi.mock("../src/capture.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/capture.ts")>();
  return {
    ...real,
    launchBrowser: async (...args: Parameters<typeof real.launchBrowser>) => {
      const browser = await real.launchBrowser(...args);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        contexts += 1;
        plan(contexts, context);
        return context;
      };
      return browser;
    },
  };
});

const dirs: string[] = [];
const html = (color: string) =>
  new Response(`<!doctype html><body style="margin:0;background:${color}"><h1>x</h1></body>`, {
    headers: { "content-type": "text/html" },
  });

/** Hits per path, and how long the first `/slow` hit holds its body (the real crash lands in that wait). */
const hits = new Map<string, number>();
/** Resolved once the first `/slow` hit has sent its head: the navigation is then in flight and stalled, so a crash lands in the goto. */
let slowHeld = Promise.withResolvers<void>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    if (path === "/boom") return new Response("no", { status: 500 });
    if (path === "/hang") {
      await Bun.sleep(5_000);
      return html("#000");
    }
    if (path === "/slow") {
      // The first hit sends a head and then stalls: red, never finished. The retry is blue.
      if (n > 1) return html("#0000ff");
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode('<!doctype html><body style="margin:0;background:#ff0000">'));
            slowHeld.resolve();
            await Bun.sleep(4_000);
            c.close();
          },
        }),
        { headers: { "content-type": "text/html" } },
      );
    }
    return html("#00ff00");
  },
});
beforeEach(() => {
  contexts = 0;
  plan = () => {};
  hits.clear();
  slowHeld = Promise.withResolvers<void>();
});
afterAll(async () => {
  await server.stop(true);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pixelslash-crash-"));
  dirs.push(dir);
  return dir;
}

function configFor(path: string, timeoutMs?: number) {
  return parseConfig({
    baseUrl: `http://127.0.0.1:${server.port}`,
    routes: [path],
    variants: [{ name: "desktop", viewport: { width: 40, height: 30 } }],
    ...(timeoutMs && { stabilise: { timeoutMs } }),
  });
}

/** One route captured; its warnings, the PNG's top-left pixel, or the error. */
async function run(path: string, timeoutMs?: number) {
  const warnings: string[] = [];
  const out = await tmp();
  try {
    const result = await captureSnapshots(configFor(path, timeoutMs), out, {
      env: { PIXELSLASH_IMAGE_VERSION: "test" },
      listFonts: async () => [],
      warn: (m) => warnings.push(m),
    });
    const entry = result.manifest.snapshots[0];
    const img = PNG.sync.read(Buffer.from(await Bun.file(join(out, entry?.file ?? "")).bytes()));
    return { warnings, rgb: Array.from(img.data.subarray(0, 3)), error: undefined };
  } catch (error) {
    return { warnings, rgb: undefined, error };
  }
}

/**
 * Make context `n`'s page fail in `call` with `message`. `crash` kills its renderer for real first
 * and waits for the `crash` event, so the error is not what says the page crashed.
 */
function failing(
  n: number,
  call: "goto" | "screenshot" | "evaluate",
  message: string,
  crash = false,
) {
  return (at: number, context: BrowserContext) => {
    if (at !== n) return;
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      const load = page.goto.bind(page);
      vi.spyOn(page, call).mockImplementation(async () => {
        if (crash) {
          // A blank page cannot be crashed; load one first.
          await load(`http://127.0.0.1:${server.port}/`);
          const crashed = new Promise((resolve) => page.once("crash", resolve));
          // Not `Page.crash`: Chromium sometimes accepts it and crashes nothing (see the
          // real-Chromium test), which would leave this awaiting a crash that never comes.
          await killRenderers(context);
          await crashed;
        }
        throw new Error(message);
      });
      return page;
    };
  };
}

/**
 * SIGKILL every renderer process of the context's browser. These tests capture one route in one
 * variant, so the browser has one page and one renderer, the page's. Throws when it finds none, so a kill that did nothing
 * is a failure of its own and not a timeout later.
 */
async function killRenderers(context: BrowserContext): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error("the context has no browser");
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const renderers = processInfo.filter((p) => p.type === "renderer");
  if (renderers.length === 0) throw new Error("no renderer process to kill");
  let killed = 0;
  for (const { id } of renderers) {
    try {
      process.kill(id, "SIGKILL");
      killed += 1;
    } catch (e) {
      // A renderer that exited between the listing and the kill is already dead.
      if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
    }
  }
  if (killed === 0) throw new Error("every renderer had already exited");
}

/** The run's error, narrowed: a test that expects the capture to fail reads its message. */
function failure(error: unknown): CaptureError {
  if (!(error instanceof CaptureError))
    throw new Error("expected a CaptureError", { cause: error });
  return error;
}

const GREEN = [0, 255, 0];

// Real browsers on a loaded machine: a crash is reported a moment after it happens.
describe(
  "a page that crashes is captured once more in a fresh context",
  { timeout: 30_000 },
  () => {
    test("goto: one crash, the retry's PNG, a warning that names the step", async () => {
      plan = failing(1, "goto", "page.goto: Page crashed");
      const { warnings, rgb, error } = await run("/");
      expect(error).toBeUndefined();
      expect(rgb).toEqual(GREEN);
      expect(warnings.filter((w) => /crashed/.test(w))).toEqual([
        "warning: index (desktop): the page crashed during goto; captured again in a fresh context",
      ]);
      expect(contexts).toBe(2);
    });

    test("the crash event alone counts, whatever the error says", async () => {
      plan = failing(1, "goto", "page.goto: net::ERR_ABORTED", true);
      const { warnings, rgb, error } = await run("/");
      expect(error).toBeUndefined();
      expect(rgb).toEqual(GREEN);
      expect(warnings.filter((w) => /crashed/.test(w))).toHaveLength(1);
      expect(contexts).toBe(2);
    });

    test("settle and screenshot are named too", async () => {
      plan = failing(1, "evaluate", "page.evaluate: Target crashed");
      const settle = await run("/");
      expect(settle.error).toBeUndefined();
      expect(settle.warnings.find((w) => /crashed/.test(w))).toMatch(/crashed during settle;/);

      contexts = 0;
      plan = failing(1, "screenshot", "page.screenshot: Target crashed");
      const shot = await run("/");
      expect(shot.error).toBeUndefined();
      expect(shot.rgb).toEqual(GREEN);
      expect(shot.warnings.find((w) => /crashed/.test(w))).toMatch(/crashed during screenshot;/);
      expect(contexts).toBe(2);
    });

    test("a second crash fails with a CaptureError, and there is no third attempt", async () => {
      plan = (n, context) => {
        if (n <= 2) failing(n, "goto", "page.goto: Page crashed")(n, context);
      };
      const { warnings, error } = await run("/");
      const message = failure(error).message;
      expect(message).toMatch(/^capture failed for http:\/\/127\.0\.0\.1:\d+\/: /);
      expect(message).toContain("index (desktop)");
      expect(message).toContain("crashed during goto again");
      expect(message).toContain("the one retry was already spent");
      expect(warnings.filter((w) => /crashed/.test(w))).toHaveLength(1);
      expect(contexts).toBe(2);
    });

    // Not the crash retry's: that is only for a crash. `captureInto` sets a timeout aside and shoots
    // it once more alone after the run (PS-474), so the page that never answers is tried twice and
    // then fails, saying so.
    test("a timeout is not a crash: it is shot once more alone, then fails", async () => {
      const { warnings, error } = await run("/hang", 600);
      expect(error).toBeInstanceOf(CaptureError);
      expect(failure(error).message).toMatch(
        /^capture failed for .*\/hang: [\s\S]*; retried alone after the run and timed out again$/,
      );
      expect(warnings.filter((w) => /crashed/.test(w))).toEqual([]);
      expect(warnings.filter((w) => w.startsWith("retry: 1 shot timed out"))).toHaveLength(1);
      expect(contexts).toBe(2);
    });

    test("an HTTP 500 is not retried", async () => {
      const { warnings, error } = await run("/boom");
      expect(failure(error).message).toMatch(/HTTP 500/);
      expect(warnings.filter((w) => /crashed/.test(w))).toEqual([]);
      expect(contexts).toBe(1);
      expect(hits.get("/boom")).toBe(1);
    });

    // The stubs above cannot show that the message text is what Playwright throws; this can. The
    // first context's renderer is killed from outside while the page is loading (`chrome://crash`
    // aborts the navigation with ERR_ABORTED before the crash is reported, so it cannot stand in).
    //
    // It flaked as `goto: Timeout 4000ms` because the kill was `Page.crash` over the DevTools
    // protocol: Chromium refuses it until the navigation has committed ("Page has pending
    // navigations, not killing"), and even after the commit it sometimes accepts it and crashes
    // nothing (re-sending does not help), so the goto waited out the stall. The kill is now a
    // SIGKILL by pid, sent once the navigation has committed and the server holds the response,
    // and a kill that cannot be made fails the test with its own error, not a timeout.
    test("real Chromium: a renderer killed mid-load is retried and the retry's PNG is kept", async () => {
      let killFailed: Error | undefined;
      plan = (n, context) => {
        if (n !== 1) return;
        context.on("page", (page) => {
          const committed = new Promise<void>((resolve) => {
            page.on("framenavigated", (frame) => {
              if (frame === page.mainFrame() && frame.url().endsWith("/slow")) resolve();
            });
          });
          void Promise.all([slowHeld.promise, committed])
            .then(() => killRenderers(context))
            .catch((e: unknown) => {
              killFailed = e instanceof Error ? e : new Error(String(e));
            });
        });
      };
      const { warnings, rgb, error } = await run("/slow", 4_000);
      expect(killFailed, "the renderer could not be killed").toBeUndefined();
      expect(error).toBeUndefined();
      expect(warnings.filter((w) => /crashed/.test(w))).toEqual([
        "warning: slow (desktop): the page crashed during goto; captured again in a fresh context",
      ]);
      expect(rgb).toEqual([0, 0, 255]);
      expect(contexts).toBe(2);
      expect(hits.get("/slow")).toBe(2);
    });
  },
);
