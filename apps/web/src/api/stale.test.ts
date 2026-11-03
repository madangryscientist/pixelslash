import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds, snapshots } from "#/db/schema";
import { get } from "./test-read";
import {
  ANDROID,
  WEB,
  type ApiTwinEntry,
  type Deps,
  readTwins,
  upload,
  world,
} from "./twins-support";

/** Stale twins on the API (PS-297): the stale list, its baselines, and the twins section's marks. */

/** Accept a shot of `buildId` as Ada did `minutesAgo` ago (a web change when `changed`). */
async function acceptAsAda(
  deps: Deps,
  shot: {
    userId: string;
    buildId: string;
    platform: string;
    changed?: boolean;
    minutesAgo?: number;
  },
) {
  const { userId, buildId, platform, ...options } = shot;
  await deps.db
    .update(snapshots)
    .set({
      reviewState: "accepted",
      reviewedBy: userId,
      reviewedAt: new Date(Date.now() - (options.minutesAgo ?? 0) * 60_000),
      ...(options.changed ? { diffStatus: "changed" as const } : {}),
    })
    .where(and(eq(snapshots.buildId, buildId), eq(snapshots.platform, platform)));
}

type ApiStale = {
  stale: {
    name: string;
    theme: string;
    platform: string;
    sentence: string;
    cause: Record<string, unknown>;
    shots: Record<string, unknown>[];
  }[];
  baselines?: { platform: string; linked: ApiTwinEntry[] };
};

const staleBody = (res: { body: unknown }): ApiStale => JSON.parse(JSON.stringify(res.body));

async function staleWorld() {
  const w = await world();
  const { deps, acme } = w;
  const first = await upload(deps, acme.token, [WEB, ANDROID], { commit: "1".repeat(40) });
  // The build is an hour old, so a later upload is a later native build.
  await deps.db
    .update(builds)
    .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
    .where(eq(builds.id, first));
  await acceptAsAda(deps, {
    userId: acme.user.id,
    buildId: first,
    platform: "android",
    minutesAgo: 30,
  });
  await acceptAsAda(deps, {
    userId: acme.user.id,
    buildId: first,
    platform: "linux",
    changed: true,
    minutesAgo: 10,
  });
  return { ...w, first };
}

describe("stale twins (PS-297)", () => {
  test("GET /projects/:id/stale lists the stale twin with a sentence and the cause", async () => {
    const { deps, acme, ada, first } = await staleWorld();
    const res = await get(deps, `/api/v1/projects/${acme.project.id}/stale`, ada);
    expect(res.status).toBe(200);
    const body = staleBody(res);
    expect(body.stale).toEqual([
      expect.objectContaining({
        name: "Button/primary",
        theme: "dark",
        platform: "android",
        sentence: expect.stringMatching(
          /^Button\/primary dark on android is stale: web changed in build http\S+\/builds\/\S+, accepted by ada \d{4}-\d\d-\d\d$/,
        ),
        cause: expect.objectContaining({
          build_id: first,
          project_id: acme.project.id,
          project_name: "web",
          accepted_by: "ada",
          accepted_at: expect.any(String),
        }),
        shots: [expect.objectContaining({ build_id: first, device: "Pixel 8 API 35" })],
      }),
    ]);
    expect("baselines" in body).toBe(false);
  });

  test("a project's own CI token reads it too, and ?platform narrows it", async () => {
    const { deps, acme, ada } = await staleWorld();
    const url = `/api/v1/projects/${acme.project.id}/stale`;
    expect(staleBody(await get(deps, url, acme.token)).stale).toHaveLength(1);
    expect(staleBody(await get(deps, `${url}?platform=ios`, ada)).stale).toEqual([]);
    const android = staleBody(await get(deps, `${url}?platform=android`, ada));
    expect(android.stale).toHaveLength(1);
    expect(android.baselines?.platform).toBe("android");
  });

  test("a bad platform is 400, a stranger 404, no token 401", async () => {
    const { deps, acme, eve } = await staleWorld();
    const url = `/api/v1/projects/${acme.project.id}/stale`;
    expect((await get(deps, `${url}?platform=web`, acme.token)).status).toBe(400);
    expect((await get(deps, url, eve)).status).toBe(404);
    expect((await get(deps, url, null)).status).toBe(401);
  });

  test("a web-only project answers with an empty list", async () => {
    const { deps, acme, ada } = await world();
    await upload(deps, acme.token, [WEB]);
    const res = await get(deps, `/api/v1/projects/${acme.project.id}/stale`, ada);
    expect(res.status).toBe(200);
    expect(staleBody(res).stale).toEqual([]);
  });

  test("the build's twins section marks the stale twin and its cause, fresh ones false", async () => {
    const { deps, acme, ada, first } = await staleWorld();
    const twins = await readTwins(deps, first, ada);
    const web = twins.linked.find((e) => e.platform === "web");
    expect(web).toMatchObject({ stale: false, stale_cause: null });
    expect(web?.twins[0]).toMatchObject({
      platform: "android",
      stale: true,
      stale_cause: { build_id: first, project_id: acme.project.id, accepted_by: "ada" },
    });
    const android = twins.linked.find((e) => e.platform === "android");
    expect(android?.twins[0]).toMatchObject({ platform: "web", stale: false, stale_cause: null });
  });
});
