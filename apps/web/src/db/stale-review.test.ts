import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test } from "vitest";
import { awaitsDecision, awaitsReason } from "#/lib/snapshot-groups";
import { countBuilds } from "./build-counts";
import { snapshots } from "./schema";
import { markStale } from "./stale-apply";
import { type World, world } from "./twins-test-support";

/**
 * What a reviewer is told about a native shot a web change left stale: it waits for a decision, for
 * the reason `stale`, and the build counts it as one to review. The rule that makes a key stale is
 * `stale.test.ts`; this is the review of the shot it leaves behind.
 */

let db: World["db"];
let web: World["web"];
let build: World["build"];

beforeEach(async () => {
  ({ db, web, build } = await world());
});

async function staleNativeBuild() {
  await build(web, 1, [{ platform: "android", diff: "unchanged", by: true }], { age: 60 });
  await build(web, 2, [{ platform: "linux", diff: "changed", by: true }], { age: 30 });
  const native = await build(web, 3, [{ platform: "android", diff: "unchanged" }], { age: 10 });
  await markStale(db, native);
  return native;
}

describe("an unchanged native shot of a stale key", () => {
  test("is still pending, awaits a decision for the reason stale, and is counted as one to review", async () => {
    const native = await staleNativeBuild();
    const [shot] = await db.select().from(snapshots).where(eq(snapshots.buildId, native));
    if (!shot) throw new Error("the build holds its shot");
    expect(shot.reviewState).toBe("pending");
    expect(awaitsDecision(shot)).toBe(true);
    expect(awaitsReason(shot)).toBe("stale");
    expect((await countBuilds(db, [native])).get(native)?.toReview).toBe(1);
  });

  test("a build whose native shot is fresh has nothing to review", async () => {
    await build(web, 1, [{ platform: "android", diff: "unchanged", by: true }], { age: 60 });
    const native = await build(web, 2, [{ platform: "android", diff: "unchanged" }], { age: 10 });
    await markStale(db, native);
    expect((await countBuilds(db, [native])).get(native)?.toReview).toBe(0);
  });
});
