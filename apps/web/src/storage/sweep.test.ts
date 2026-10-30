import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { orgSweepBlobs, r2SweepStore } from "./blobs";

let mf: Miniflare;
let bucket: R2Bucket;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        { name: "w", modules: true, script: "export default {}", r2Buckets: { BLOBS: "sweep" } },
      ],
    }),
  );
  bucket = (await mf.getBindings<{ BLOBS: R2Bucket }>()).BLOBS;
});
afterAll(() => mf?.dispose());

const png = (n: number) => new Uint8Array(n).buffer;

describe("the R2 sweep store", () => {
  // R2 lists 1000 keys a page, so 1001 objects is the smallest directory that takes two.
  test(
    "lists a directory with sizes, past one page, and not its neighbours",
    { timeout: 120_000 },
    async () => {
      const store = r2SweepStore(bucket);
      const many = Array.from({ length: 1001 }, (_, i) => `orgs/o1/builds/big/${i}.png`);
      await Promise.all(many.map((key) => bucket.put(key, png(3))));
      await bucket.put("orgs/o1/builds/big-neighbour/x.png", png(1));
      const listed = await store.list("orgs/o1/builds/big");
      expect(listed).toHaveLength(1001);
      expect(listed.every((o) => o.size === 3)).toBe(true);
      expect(listed.some((o) => o.key.includes("neighbour"))).toBe(false);
    },
  );

  test("deletes more keys than one R2 call takes, leaving the rest", async () => {
    const store = r2SweepStore(bucket);
    const listed = await store.list("orgs/o1/builds/big");
    await store.deleteMany(listed.map((o) => o.key));
    expect(await store.list("orgs/o1/builds/big")).toEqual([]);
    expect(await store.list("orgs/o1/builds/big-neighbour")).toHaveLength(1);
  });

  test("an org's view lists its own keys without the prefix and never another org's", async () => {
    const store = r2SweepStore(bucket);
    await bucket.put("orgs/a/builds/b1/one.png", png(5));
    await bucket.put("orgs/b/builds/b1/one.png", png(7));
    const a = orgSweepBlobs(store, "a");
    expect(await a.list("builds/b1")).toEqual([{ key: "builds/b1/one.png", size: 5 }]);
    await a.deleteMany(["builds/b1/one.png"]);
    expect(await store.list("orgs/a/builds/b1")).toEqual([]);
    expect(await store.list("orgs/b/builds/b1")).toHaveLength(1);
    expect(() => a.deleteMany(["../b/builds/b1/one.png"])).toThrow(/unsafe/);
  });
});
