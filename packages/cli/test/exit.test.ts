import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanup } from "./support.ts";
import { WAITING_EXIT } from "../src/status.ts";
import { USER_TOKEN, build, fakeApi } from "./remote-support.ts";

afterAll(cleanup);

const CHILD = fileURLToPath(new URL("./exit-child.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Run `cmd` with both streams as pipes, read to the end, and return what the parent saw. */
async function piped(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("exitAfterFlush", () => {
  test("a child that writes over 1 MB to a pipe and exits through the helper is read whole", async () => {
    for (let i = 0; i < 3; i++) {
      const out = await piped([process.execPath, CHILD]);
      expect(out.code).toBe(3);
      expect(out.stdout.length).toBeGreaterThan(1_000_000);
      expect(JSON.parse(out.stdout).rows).toHaveLength(20000);
      expect(out.stderr.trim()).toHaveLength(300_000);
    }
  });

  test("the real entry point pipes `status --json` whole", async () => {
    const api = fakeApi();
    const snapshots = Array.from({ length: 6000 }, (_, i) => ({
      name: `shot-${i}`,
      viewport: "1280x720",
      theme: "light",
      group: "changed",
      review_state: "pending",
      skipped_flaky: false,
    }));
    api.replies["/api/v1/builds/b2"] = { api_version: 1, build: { ...build("b2"), snapshots } };
    const server = Bun.serve({
      port: 0,
      fetch: (req) => api.fetch(req.url, { method: req.method, headers: req.headers }),
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      for (let i = 0; i < 3; i++) {
        const out = await piped(
          [process.execPath, ENTRY, "status", "--build", "b2", "--json", "--server", url],
          { PIXELSLASH_TOKEN: USER_TOKEN },
        );
        expect(out.stdout.length).toBeGreaterThan(500_000);
        expect(JSON.parse(out.stdout).build.snapshots).toHaveLength(6000);
        expect(out.code).toBe(WAITING_EXIT);
      }
    } finally {
      await server.stop(true);
    }
  }, 30_000);
});
