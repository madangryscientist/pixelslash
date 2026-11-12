import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds } from "#/db/schema";
import { call, openBuild, setup, snapshotForm } from "./test-support";

describe("the timings a finalize stores", () => {
  test("the capture profile sent at finalize is stored whole; a malformed extra is dropped alone", async () => {
    const { db, deps, acme } = await setup();
    const settle = { fontsMs: 5, imagesMs: 6, networkIdleMs: 500, framesMs: 30 };
    const profile = {
      totalMs: 2000,
      browserLaunchMs: 300,
      captureWallMs: 900,
      workers: { capture: 4, upload: 4 },
      host: { cores: 16, loadStart: 1.5, loadEnd: 3.25 },
      captureMs: 3200,
      navigateMs: 400,
      settleMs: 2500,
      screenshotMs: 200,
      setupMs: 60,
      storyMs: 120,
      measureMs: 40,
      settle,
      diffMs: 40,
      upload: {
        totalMs: 700,
        batches: [
          { step: "upload", count: 4, ms: 600, p50Ms: 140, p90Ms: 220, maxMs: 230, wallMs: 300 },
        ],
      },
      shots: [
        {
          name: "pricing",
          captureMs: 3200,
          diffMs: 40,
          navigateMs: 400,
          settleMs: 2500,
          screenshotMs: 200,
          setupMs: 60,
          storyMs: 120,
          measureMs: 40,
          settle,
        },
      ],
    };
    const stored = async (body: unknown) => {
      const id = await openBuild(deps, acme.token);
      await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
      const res = await call(
        deps,
        `POST /api/v1/builds/${id}/finalize`,
        acme.token,
        JSON.stringify(body),
      );
      expect(res.status).toBe(200);
      const [row] = await db.select().from(builds).where(eq(builds.id, id));
      return row?.timings;
    };
    expect(await stored({ snapshots: 1, timings: profile })).toEqual(profile);
    // A body of today's shape, with none of the new fields, is stored as it was sent.
    const old = {
      totalMs: 1200,
      captureMs: 800,
      upload: { totalMs: 300, batches: [{ step: "upload", count: 1, ms: 250 }] },
      shots: [{ name: "pricing", captureMs: 800 }],
    };
    expect(await stored({ snapshots: 1, timings: old })).toEqual(old);
    // Each malformed new field is dropped on its own; the rest of the timings is kept.
    const kept = await stored({
      snapshots: 1,
      timings: {
        ...profile,
        captureWallMs: "slow",
        workers: { capture: 0, upload: 4 },
        host: { cores: 16, loadStart: "high", loadEnd: 3 },
        storyMs: -5,
        settle: { fontsMs: 1 },
        upload: {
          totalMs: 700,
          batches: [{ step: "upload", count: 4, ms: 600, p50Ms: "x", p90Ms: 220, maxMs: -1 }],
        },
        shots: [{ name: "pricing", captureMs: 3200, setupMs: "x", measureMs: 40, settle: 3 }],
      },
    });
    const {
      captureWallMs: _wall,
      host: _host,
      storyMs: _story,
      settle: _settle,
      ...rest
    } = profile;
    expect(kept).toEqual({
      ...rest,
      workers: { upload: 4 },
      upload: { totalMs: 700, batches: [{ step: "upload", count: 4, ms: 600, p90Ms: 220 }] },
      shots: [{ name: "pricing", captureMs: 3200, measureMs: 40 }],
    });
  });
});
