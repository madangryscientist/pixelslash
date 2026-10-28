import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { snapshot } from "@hackcove/pixelslash-playwright";

const PAGE = `<!doctype html>
<html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  .clock { position: absolute; left: 24px; top: 80px; width: 200px; height: 32px; }
  .token { position: absolute; left: 24px; top: 140px; margin: 0; }
</style></head><body>
  <h1>Dashboard</h1>
  <p class="clock" id="clock"></p>
  <p class="token">session psci_not_for_upload</p>
  <script>
    setInterval(() => { document.getElementById("clock").textContent = new Date().toISOString(); }, 50);
  </script>
</body></html>`;

let server: Server;
let url: string;

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dashboard`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

test("the dashboard", async ({ page }) => {
  await page.goto(url);
  // The clock changes on every shot, so the diff skips it; the token never leaves the machine.
  const entry = await snapshot(page, "dashboard", { ignore: ["#clock"], redact: [".token"] });
  expect(entry.ignore).toHaveLength(1);
  expect(entry.file).toBe("dashboard/1024x768-light.png");
});
