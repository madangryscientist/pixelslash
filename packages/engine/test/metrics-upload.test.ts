import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { UsageError } from "../src/errors.ts";
import { readManifest } from "../src/manifest.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { fakeServer } from "./fake-server.ts";
import { cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

const FILE = JSON.stringify({
  version: "1.0",
  root: "button",
  parts: { button: { box: { x: 0, y: 0, w: 96, h: 40 } } },
});

describe("metrics in the manifest", () => {
  test("an entry without metrics reads as before, with no field", async () => {
    const dir = await snapshotDir([entry("home")]);
    const [home] = (await readManifest(dir)).snapshots;
    expect(home).not.toHaveProperty("metrics");
  });

  test("an entry's metrics file is read and checked", async () => {
    const dir = await snapshotDir([
      entry("home", "desktop", { metrics: "home/desktop.metrics.json" }),
    ]);
    await expect(readManifest(dir)).rejects.toThrow(/home\/desktop\.metrics\.json does not exist/);
    await Bun.write(join(dir, "home/desktop.metrics.json"), "{nope");
    await expect(readManifest(dir)).rejects.toThrow(
      /home\/desktop\.metrics\.json is not valid JSON/,
    );
    await Bun.write(join(dir, "home/desktop.metrics.json"), FILE);
    const [home] = (await readManifest(dir)).snapshots;
    expect(home?.metrics).toBe("home/desktop.metrics.json");
  });

  test.each([
    [42, /metrics must be a path ending \.metrics\.json/],
    ["home/desktop.json", /metrics must be a path ending \.metrics\.json/],
    ["../x.metrics.json", /outside/],
  ])("refuses metrics %j", async (metrics, message) => {
    const dir = await snapshotDir([entry("home", "desktop", { metrics })]);
    await expect(readManifest(dir)).rejects.toThrow(message);
  });

  test("a bad metrics file is a usage error (exit 2)", async () => {
    const dir = await snapshotDir([
      entry("home", "desktop", { metrics: "home/desktop.metrics.json" }),
    ]);
    await Bun.write(join(dir, "home/desktop.metrics.json"), "[]");
    await expect(readManifest(dir)).rejects.toThrow(UsageError);
  });
});

describe("metrics in the upload", () => {
  test("a shot with a metrics file sends it as `metrics`, byte for byte; a shot without sends none", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([
      entry("home", "desktop", { metrics: "home/desktop.metrics.json" }),
      entry("pricing"),
    ]);
    // A higher minor's extra field travels untouched.
    const written = JSON.stringify({ ...JSON.parse(FILE), version: "1.4", extra: { a: 1 } });
    await Bun.write(join(dir, "home/desktop.metrics.json"), written);
    const server = fakeServer();
    await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server.fetch, env: {} },
    );
    const forms = server.calls
      .filter((c) => c.method === "PUT")
      .map((c) => c.body)
      .filter((b): b is FormData => b instanceof FormData);
    expect(forms).toHaveLength(2);
    const withMetrics = forms.filter((f) => f.has("metrics"));
    expect(withMetrics).toHaveLength(1);
    const sent = withMetrics[0]?.get("metrics");
    if (!(sent instanceof File)) throw new Error("the metrics part is not a file");
    expect(await sent.text()).toBe(written);
  });
});
