import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ABANDONED_AFTER_MS, ABANDONED_REASON, sweepAbandoned } from "#/db/abandoned";
import { syncEnded } from "./abandoned";
import { builds, snapshots } from "#/db/schema";
import { syncCheckRuns } from "#/github/check-run";
import { call, idOf, newBuild, openBuild, setup, snapshotForm } from "./test-support";

vi.mock("#/db/abandoned", async (original) => {
  const real = await original<typeof import("#/db/abandoned")>();
  return { ...real, sweepAbandoned: vi.fn<typeof real.sweepAbandoned>(real.sweepAbandoned) };
});

vi.mock("#/github/check-run", async (original) => {
  const real = await original<typeof import("#/github/check-run")>();
  return { ...real, syncCheckRuns: vi.fn<typeof real.syncCheckRuns>(real.syncCheckRuns) };
});

afterEach(() => vi.restoreAllMocks());

const LONG_AGO = new Date(Date.now() - ABANDONED_AFTER_MS - 60 * 60 * 1000);

const statusOf = async (db: Awaited<ReturnType<typeof setup>>["db"], id: string) => {
  const [row] = await db.select().from(builds).where(eq(builds.id, id));
  return row;
};
const age = (db: Awaited<ReturnType<typeof setup>>["db"], id: string) =>
  db.update(builds).set({ createdAt: LONG_AGO }).where(eq(builds.id, id));

describe("creating a build sweeps the project's abandoned ones (PS-324)", () => {
  test("this project's abandoned build ends, another project's is left", async () => {
    const { db, deps, acme, other } = await setup();
    const mine = await openBuild(deps, acme.token);
    const theirs = await openBuild(deps, other.token);
    await age(db, mine);
    await age(db, theirs);

    const created = await call(deps, "POST /api/v1/builds", acme.token, newBuild());
    expect(created.status).toBe(201);
    const fresh = await idOf(created);

    expect(await statusOf(db, mine)).toMatchObject({ status: "errored", error: ABANDONED_REASON });
    expect(await statusOf(db, theirs)).toMatchObject({ status: "uploading", error: null });
    expect((await statusOf(db, fresh))?.status).toBe("uploading");
  });

  test("a sweep that throws is logged and the build is still created", async () => {
    const { db, deps, acme } = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(sweepAbandoned).mockRejectedValueOnce(new Error("d1 is down"));

    const created = await call(deps, "POST /api/v1/builds", acme.token, newBuild());
    expect(created.status).toBe(201);
    expect((await statusOf(db, await idOf(created)))?.status).toBe("uploading");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("d1 is down"));
  });

  test("a build the sweep ended resumes when finalise is sent again (ob 1545)", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    await age(db, id);
    // The shot was uploaded just now, so it is the build's last activity: age it too.
    await db.update(snapshots).set({ createdAt: LONG_AGO }).where(eq(snapshots.buildId, id));
    await call(deps, "POST /api/v1/builds", acme.token, newBuild());
    expect((await statusOf(db, id))?.status).toBe("errored");

    const done = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(done.status).toBe(200);
    const body: { status: string; error: string | null } = await done.json();
    expect(body.error).toBeNull();
    expect(body.status).not.toBe("errored");
    expect((await statusOf(db, id))?.status).toBe(body.status);
  });
});

describe("syncing ended builds' check runs (PS-324)", () => {
  test("only a commit's newest build is synced, so an older one cannot overwrite its status", async () => {
    const { db, acme } = await setup();
    const row = (id: string, commitSha: string, hoursAgo: number) => ({
      id,
      projectId: acme.project.id,
      commitSha,
      branch: "feat/x",
      status: "errored" as const,
      createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    });
    await db
      .insert(builds)
      .values([
        row("old", "a".repeat(40), 30),
        row("new", "a".repeat(40), 20),
        row("solo", "b".repeat(40), 25),
      ]);

    await syncEnded({ db, app: null, token: null, publicUrl: undefined }, ["old", "new", "solo"]);

    expect(vi.mocked(syncCheckRuns)).toHaveBeenCalledTimes(1);
    const [, ids] = vi.mocked(syncCheckRuns).mock.calls[0] ?? [];
    expect([...(ids ?? [])].toSorted()).toEqual(["new", "solo"]);
  });
});
