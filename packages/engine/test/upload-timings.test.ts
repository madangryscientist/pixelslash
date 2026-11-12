import { afterAll, describe, expect, test } from "vitest";
import type { Timings } from "../src/timings.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { fakeServer } from "./fake-server.ts";
import { cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/** The capture's profile, the host and the workers go to the server in the finalize body. */
describe("the timings an upload sends", () => {
  test("finalize carries the capture's wall, the worker counts, the host and each request kind's spread", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("home"), entry("pricing")]);
    const server = fakeServer();
    const captured: Timings = {
      totalMs: 900,
      captureMs: 800,
      captureWallMs: 450,
      workers: { capture: 2 },
      host: { cores: 8, loadStart: 1.25, loadEnd: 2.5 },
      shots: [{ name: "home", captureMs: 800, setupMs: 40, measureMs: 12 }],
    };
    const result = await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd), timings: captured },
      { fetch: server.fetch },
    );
    expect(server.calls.at(-1)?.body).toMatchObject({
      timings: {
        captureWallMs: 450,
        workers: { capture: 2, upload: 2 },
        host: { cores: expect.any(Number), loadStart: 1.25, loadEnd: expect.any(Number) },
        shots: [{ name: "home", captureMs: 800, setupMs: 40, measureMs: 12 }],
        upload: {
          batches: expect.arrayContaining([
            expect.objectContaining({
              step: "upload",
              p50Ms: expect.any(Number),
              p90Ms: expect.any(Number),
              maxMs: expect.any(Number),
              wallMs: expect.any(Number),
            }),
          ]),
        },
      },
    });
    for (const batch of result.timings.upload?.batches ?? []) {
      expect(batch.p50Ms).toBeLessThanOrEqual(batch.p90Ms);
      expect(batch.p90Ms).toBeLessThanOrEqual(batch.maxMs);
      expect(batch.wallMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("an upload of existing PNGs, with no capture, still reports its workers and host", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("home")]);
    const server = fakeServer();
    const result = await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server.fetch },
    );
    expect(result.timings).toMatchObject({
      workers: { upload: 1 },
      host: { cores: expect.any(Number) },
    });
    expect(result.timings).not.toHaveProperty("captureWallMs");
    expect(result.timings.workers).not.toHaveProperty("capture");
  });
});
