import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { builds } from "#/db/schema";
import { call, idOf, newBuild, setup } from "./test-support";

/** A build's brief through `POST /api/v1/builds` (PS-232): trimmed, stored, refused past 4000. */

const briefOf = async (held: Awaited<ReturnType<typeof setup>>, id: string) =>
  (await held.db.select({ brief: builds.brief }).from(builds).where(eq(builds.id, id)))[0]?.brief;

describe("a build's brief", () => {
  test("is stored trimmed, and a build without one, or with only spaces, has none", async () => {
    const held = await setup();
    const open = (extra: object) =>
      call(held.deps, "POST /api/v1/builds", held.acme.token, newBuild(extra));
    const given = await open({ brief: "  Move the card's corner to red.\n" });
    expect(given.status).toBe(201);
    expect(await briefOf(held, await idOf(given))).toBe("Move the card's corner to red.");
    expect(await briefOf(held, await idOf(await open({})))).toBeNull();
    expect(await briefOf(held, await idOf(await open({ brief: "   " })))).toBeNull();
  });

  test("over 4000 characters is a 422 that names the limit, and opens no build", async () => {
    const held = await setup();
    const res = await call(
      held.deps,
      "POST /api/v1/builds",
      held.acme.token,
      newBuild({ brief: "x".repeat(9000) }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "brief is 9000 characters; the limit is 4000" });
    expect(await held.db.select().from(builds)).toHaveLength(0);
  });

  test("a brief that is not a string is a 400", async () => {
    const held = await setup();
    const res = await call(
      held.deps,
      "POST /api/v1/builds",
      held.acme.token,
      newBuild({ brief: 7 }),
    );
    expect(res.status).toBe(400);
  });
});
