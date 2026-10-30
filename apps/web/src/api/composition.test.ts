import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { snapshots } from "#/db/schema";
import { MAX_FINDINGS } from "./validate-composition";
import { META, call, openBuild, setup, snapshotForm } from "./test-support";

const FOUND = {
  library: "Hack Cove UI",
  gaps: [
    {
      kind: "class",
      selector: "#go",
      tag: "button",
      classes: ["mt-7"],
      style: null,
      box: { x: 2, y: 4, width: 10, height: 6 },
    },
  ],
  special: [
    { selector: "#logo", reason: "drawn by hand", box: { x: 0, y: 0, width: 8, height: 8 } },
  ],
};

describe("a shot's composition findings (ob 1850)", () => {
  test("are stored as sent; a shot without them stores null", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `PUT /api/v1/builds/${id}/snapshots`;
    const sent = snapshotForm({ ...META, composition: FOUND });
    expect((await call(deps, path, acme.token, sent)).status).toBe(200);
    expect(
      (await call(deps, path, acme.token, snapshotForm({ ...META, name: "plain" }))).status,
    ).toBe(200);
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    const by = new Map(rows.map((r) => [r.name, r.composition]));
    expect(by.get("pricing")).toEqual(FOUND);
    expect(by.get("plain")).toBeNull();
  });

  test("a malformed or oversized list is a 400 naming the field, and nothing is stored", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const path = `PUT /api/v1/builds/${id}/snapshots`;
    const many = Array.from({ length: MAX_FINDINGS + 1 }, () => FOUND.special[0]);
    for (const [composition, message] of [
      [{ ...FOUND, gaps: [{ ...FOUND.gaps[0], kind: "nope" }] }, "composition.gaps[0].kind"],
      [{ ...FOUND, special: many }, `at most ${MAX_FINDINGS}`],
      ["yes", "composition"],
    ] as const) {
      const res = await call(deps, path, acme.token, snapshotForm({ ...META, composition }));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(message);
    }
    expect(await db.select().from(snapshots)).toHaveLength(0);
  });
});
