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

/** The bucket as the store sees it, recording what `list` is asked and how many keys a delete takes. */
const recording = (target: R2Bucket) => {
  const lists: R2ListOptions[] = [];
  const deletes: number[] = [];
  const view = {
    put: target.put.bind(target),
    get: target.get.bind(target),
    list: (options?: R2ListOptions) => {
      lists.push({ ...options });
      return target.list(options);
    },
    delete: (keys: string | string[]) => {
      deletes.push([keys].flat().length);
      return target.delete(keys);
    },
  };
  return { view, lists, deletes };
};

describe("the R2 sweep store", () => {
  // R2's real numbers are 1000 keys a page and 1000 per delete. The store takes both as options so
  // the cursor and the batching are proved with a handful of objects, not a thousand writes.
  const PAGE = 2;
  const BATCH = 2;

  test("lists a directory with sizes, past one page, and not its neighbours", async () => {
    const { view, lists } = recording(bucket);
    const store = r2SweepStore(view, { pageSize: PAGE, deleteBatch: BATCH });
    const many = Array.from({ length: 5 }, (_, i) => `orgs/o1/builds/big/${i}.png`);
    await Promise.all(many.map((key) => bucket.put(key, png(3))));
    await bucket.put("orgs/o1/builds/big-neighbour/x.png", png(1));
    const listed = await store.list("orgs/o1/builds/big");
    expect(listed.map((o) => o.key).toSorted()).toEqual(many);
    expect(listed.every((o) => o.size === 3)).toBe(true);
    expect(listed.some((o) => o.key.includes("neighbour"))).toBe(false);
    // Three pages of at most 2, the second and third following the cursor of the one before.
    expect(lists.map((l) => [l.limit, l.cursor !== undefined])).toEqual([
      [PAGE, false],
      [PAGE, true],
      [PAGE, true],
    ]);
  });

  test("deletes more keys than one call takes, leaving the rest", async () => {
    const { view, deletes } = recording(bucket);
    const store = r2SweepStore(view, { pageSize: PAGE, deleteBatch: BATCH });
    const listed = await store.list("orgs/o1/builds/big");
    expect(listed).toHaveLength(5);
    await store.deleteMany(listed.map((o) => o.key));
    expect(deletes).toEqual([2, 2, 1]);
    expect(await store.list("orgs/o1/builds/big")).toEqual([]);
    expect(await store.list("orgs/o1/builds/big-neighbour")).toHaveLength(1);
  });

  test("with no options it passes no limit and deletes 1000 keys a call", async () => {
    const { view, lists, deletes } = recording(bucket);
    const store = r2SweepStore(view);
    await store.list("orgs/none");
    await store.deleteMany(Array.from({ length: 2001 }, (_, i) => `orgs/none/k${i}`));
    expect(lists).toEqual([{ prefix: "orgs/none/" }]);
    expect(deletes).toEqual([1000, 1000, 1]);
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
