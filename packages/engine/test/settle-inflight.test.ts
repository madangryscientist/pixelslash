import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Browser } from "playwright";
import { launchBrowser } from "../src/capture.ts";
import { openPage, type ShotProgress } from "../src/capture-open.ts";
import { parseConfig } from "../src/config.ts";

// The CLI's shot path (`openPage`) against real Chromium: a page whose content arrives from a slow fetch is
// shot with it, a page that hydrates before it fetches is shot after the fetch, and a static page does not pay
// a fixed network or idle window.

/**
 * A page that renders "Loading...", then works the main thread for about 200ms in small slices posted
 * through a MessageChannel (as React's scheduler does while it hydrates, with no request in flight), and
 * only then fetches its data and renders it.
 */
const HYDRATING = `<!doctype html><body><p id="out">Loading...</p><script>
  const channel = new MessageChannel();
  const until = performance.now() + 200;
  channel.port1.onmessage = () => {
    const slice = performance.now() + 5;
    while (performance.now() < slice) {}
    if (performance.now() < until) return channel.port2.postMessage(null);
    fetch("/hydrated-data").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = d.text; });
  };
  channel.port2.postMessage(null);
</script>`;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/slow-data") {
      await Bun.sleep(300);
      return Response.json({ text: "arrived late" });
    }
    if (path === "/hydrated-data") return Response.json({ text: "hydrated and loaded" });
    if (path === "/hydrating")
      return new Response(HYDRATING, { headers: { "content-type": "text/html" } });
    if (path === "/slow") {
      return new Response(
        `<!doctype html><body><p id="out">loading</p><script>
          fetch("/slow-data").then((r) => r.json()).then((d) => { document.getElementById("out").textContent = d.text; });
        </script>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response("<!doctype html><body><h1>Static</h1>", {
      headers: { "content-type": "text/html" },
    });
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  await server.stop(true);
});

/** The CLI's own shot path: `openPage` attaches the tracker, navigates and settles. */
async function settled(path: string) {
  const route = parseConfig({ baseUrl: `http://127.0.0.1:${server.port}`, routes: [path] })
    .routes[0]!;
  const page = await browser.newPage();
  try {
    const progress: ShotProgress = { step: "goto", crashed: false };
    const opened = await openPage(page, `http://127.0.0.1:${server.port}${path}`, route, {
      timeoutMs: 8_000,
      progress,
    });
    return { steps: opened.settle, text: await page.locator("body").innerText() };
  } finally {
    await page.close();
  }
}

describe("the in-flight settle in Chromium", () => {
  test("a page whose content comes from a fetch delayed 300ms is shot with that content", async () => {
    const { text } = await settled("/slow");
    expect(text).toContain("arrived late");
  });

  test("a page that fetches its data only after 200ms of main-thread work is shot with that data", async () => {
    const { text } = await settled("/hydrating");
    expect(text).toContain("hydrated and loaded");
  });

  test("a static page's network and idle waits are each under 50ms", async () => {
    const { steps } = await settled("/");
    expect(steps.networkIdleMs).toBeLessThan(50);
    expect(steps.idleMs).toBeLessThan(50);
  });
});
