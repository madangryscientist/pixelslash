import { describe, expect, test } from "vitest";
import { call, openBuild, setup, snapshotForm } from "./test-support";

/** The names in a `Server-Timing` header: `auth;dur=1.5, db;dur=3` is `["auth", "db"]`. */
function parts(res: Response): Record<string, number> {
  const header = res.headers.get("server-timing") ?? "";
  return Object.fromEntries(
    header.split(", ").map((entry) => {
      const [name = "", dur = ""] = entry.split(";dur=");
      return [name, Number(dur)];
    }),
  );
}

describe("the Server-Timing header on /api/v1", () => {
  test("a snapshot PUT names where its time went, and its body is as it was", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const put = await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ id: expect.any(String) });
    const got = parts(put);
    expect(Object.keys(got)).toEqual(
      expect.arrayContaining(["auth", "build", "form", "digest", "blob", "db", "flake", "total"]),
    );
    expect(Object.keys(got).at(-1)).toBe("total");
    for (const ms of Object.values(got)) expect(ms).toBeGreaterThanOrEqual(0);
    // The parts are inside the whole.
    const { total, ...inside } = got;
    expect(Object.values(inside).reduce((n, ms) => n + ms, 0)).toBeLessThanOrEqual(
      (total ?? 0) + 1,
    );
  });

  test("a finalize names the finalise, the check-run sync, the baseline pick, the measuring and the removed markers", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await call(deps, `PUT /api/v1/builds/${id}/snapshots`, acme.token, snapshotForm());
    const done = await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ snapshots: 1 }),
    );
    expect(done.status).toBe(200);
    expect(Object.keys(await done.json())).toEqual([
      "id",
      "status",
      "error",
      "unmeasured",
      "web_url",
    ]);
    expect(Object.keys(parts(done))).toEqual(
      expect.arrayContaining(["finalise", "sync", "baselines", "measure", "removed", "total"]),
    );
  });

  test("every other answer carries at least a total, errors included", async () => {
    const { deps, acme } = await setup();
    const me = await call(deps, "GET /api/v1/me", acme.token);
    expect(Object.keys(parts(me))).toEqual(expect.arrayContaining(["auth", "total"]));
    const refused = await call(deps, "GET /api/v1/me", "psci_wrong");
    expect(refused.status).toBe(401);
    expect(Object.keys(parts(refused))).toContain("total");
    const missing = await call(deps, "GET /api/v1/nothing", acme.token);
    expect(missing.status).toBe(404);
    expect(Object.keys(parts(missing))).toContain("total");
  });
});
