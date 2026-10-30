import { describe, expect, test } from "vitest";
import { fetchBaselines } from "../src/baselines-client.ts";
import type { SnapshotEntry } from "../src/snapshot.ts";
import type { Client } from "../src/upload-client.ts";
import { entry } from "./upload-fixtures.ts";

/** The chunked baselines fetch shared by `upload` and `check`: picks in order, `removed` across chunks. */

const pick = { baseline: null, carry: null, accepted: null };
const gone = (name: string) => ({
  name,
  browser: "chromium",
  viewport: "1280x720",
  theme: "light",
});

/** A client whose server answers each request with `removed` of that request's turn (undefined: absent). */
function client(removedByRequest: (unknown[] | undefined)[], verb?: "check"): Client {
  let n = 0;
  return {
    fetch: async (_url, init) => {
      const keys: unknown[] = JSON.parse(typeof init?.body === "string" ? init.body : "{}").keys;
      const removed = removedByRequest[n++];
      return Response.json({
        diff_location: "server",
        baselines: keys.map(() => pick),
        ...(removed ? { removed } : {}),
      });
    },
    base: "https://ps.example",
    token: "t",
    warn: () => {},
    sleep: async () => {},
    ...(verb ? { verb } : {}),
  };
}

const entries = (n: number): SnapshotEntry[] =>
  Array.from({ length: n }, (_, i) => {
    const e = entry(`s${i}`);
    const variant = { ...e.variant, browser: "chromium" as const, theme: "light" as const };
    return { ...e, variant, ignore: [], flaky: "review" };
  });

describe("fetchBaselines", () => {
  test("intersects what each chunk says would be removed", async () => {
    const c = client([
      [gone("a"), gone("b")],
      [gone("b"), gone("c")],
    ]);
    const got = await fetchBaselines(c, { path: "/api/v1/baselines" }, entries(501));
    expect(got.picks).toHaveLength(501);
    expect(got.removed?.map((k) => k.name)).toEqual(["b"]);
  });

  test("one chunk that does not say makes it unreported", async () => {
    const c = client([[gone("a")], undefined]);
    const got = await fetchBaselines(c, { path: "/api/v1/baselines" }, entries(501));
    expect(got.removed).toBeUndefined();
  });

  test("an empty reply fails in the command's own words", async () => {
    const bare: Client = { ...client([]), fetch: async () => Response.json({ baselines: [] }) };
    const path = "/api/v1/baselines";
    await expect(fetchBaselines(bare, { path }, entries(1))).rejects.toThrow(
      "upload failed: fetch baselines: the server's reply has no baselines",
    );
    await expect(fetchBaselines({ ...bare, verb: "check" }, { path }, entries(1))).rejects.toThrow(
      "check failed: fetch baselines: the server's reply has no baselines",
    );
  });
});
