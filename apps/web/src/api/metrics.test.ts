import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { MAX_METRICS_BYTES } from "@hackcove/pixelslash-engine/metrics-entry";
import { snapshots } from "#/db/schema";
import { loadMetrics } from "#/server/metrics-read";
import { orgBlobs } from "#/storage/blobs";
import { verifySignedImagePath } from "#/storage/signed";
import { get } from "./test-read";
import { META, PNG, call, openBuild, setup } from "./test-support";

/** A shot's layout metrics file (PS-294, `docs/metrics.md`): upload, storage and the read. */

const FILE = JSON.stringify({
  version: "1.3",
  root: "button",
  future: true,
  parts: {
    button: { box: { x: 0, y: 0, w: 96, h: 40 }, shadow: "none" },
    "button.label": { box: { x: 40, y: 10, w: 40, h: 20 }, font: { size: 14, weight: 600 } },
  },
});

function form(meta: object, metrics?: string | Uint8Array<ArrayBuffer>) {
  const f = new FormData();
  f.set("meta", JSON.stringify(meta));
  f.set("file", new File([PNG.slice()], "shot.png", { type: "image/png" }));
  if (metrics !== undefined)
    f.set("metrics", new File([metrics], "metrics.json", { type: "application/json" }));
  return f;
}

const put = (deps: Parameters<typeof call>[0], id: string, token: string, body: FormData) =>
  call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, body);

describe("a shot's layout metrics", () => {
  test("are stored as sent beside the PNG, and the row records the key; a shot without metrics has none", async () => {
    const { db, deps, blobs, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    expect((await put(deps, id, acme.token, form(META, FILE))).status).toBe(200);
    expect((await put(deps, id, acme.token, form({ ...META, name: "plain" }))).status).toBe(200);

    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    const withMetrics = rows.find((r) => r.name === META.name);
    const plain = rows.find((r) => r.name === "plain");
    expect(plain?.metricsKey).toBeNull();
    expect(withMetrics?.metricsKey).toMatch(/^builds\/.+\.metrics\.json$/);
    const stored = blobs.data.get(`orgs/${acme.org.id}/${withMetrics?.metricsKey}`);
    // The bytes are the client's own: a higher minor's extra fields are kept.
    expect(new TextDecoder().decode(stored)).toBe(FILE);
    expect([...blobs.data.keys()].filter((k) => k.endsWith(".metrics.json"))).toHaveLength(1);
  });

  test("a re-upload without metrics clears the key", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await put(deps, id, acme.token, form(META, FILE));
    await put(deps, id, acme.token, form(META));
    const [row] = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    expect(row?.metricsKey).toBeNull();
  });

  test.each([
    ["not JSON", "{nope", "metrics is not valid JSON"],
    [
      "a higher major",
      JSON.stringify({
        version: "2.0",
        root: "a",
        parts: { a: { box: { x: 0, y: 0, w: 1, h: 1 } } },
      }),
      "version",
    ],
  ])(
    "a malformed file (%s) is a 400 naming the field, and nothing is stored",
    async (_n, bad, message) => {
      const { db, deps, blobs, acme } = await setup();
      const id = await openBuild(deps, acme.token);
      const res = await put(deps, id, acme.token, form(META, bad));
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(message);
      expect(await db.select().from(snapshots)).toHaveLength(0);
      expect([...blobs.data.keys()].some((k) => k.endsWith(".metrics.json"))).toBe(false);
    },
  );

  test("a file over the cap is refused with 413", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    const big = new Uint8Array(MAX_METRICS_BYTES * 2 + 1);
    expect((await put(deps, id, acme.token, form(META, big))).status).toBe(413);
  });

  test("the snapshot read gives a signed metrics_url, and null without metrics", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await put(deps, id, acme.token, form(META, FILE));
    await put(deps, id, acme.token, form({ ...META, name: "plain" }));
    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    const withMetrics = rows.find((r) => r.name === META.name);
    const plain = rows.find((r) => r.name === "plain");

    const res = await get(deps, `/api/v1/snapshots/${withMetrics?.id}`, acme.token);
    expect(res.status).toBe(200);
    const url = new URL(res.body.snapshot.metrics_url ?? "");
    const key = `orgs/${acme.org.id}/${withMetrics?.metricsKey}`;
    expect(decodeURIComponent(url.pathname)).toBe(`/images/${key}`);
    expect(
      await verifySignedImagePath({
        key,
        expires: url.searchParams.get("exp"),
        sig: url.searchParams.get("sig"),
        secret: "test-image-secret",
      }),
    ).toBe(true);

    const none = await get(deps, `/api/v1/snapshots/${plain?.id}`, acme.token);
    expect(none.body.snapshot.metrics_url).toBeNull();
  });
});

describe("loadMetrics", () => {
  test("reads a stored file, and is null for no key, a lost blob or a file that no longer reads", async () => {
    const { blobs, acme } = await setup();
    const scoped = orgBlobs(blobs.store, acme.org.id);
    await scoped.put("m.metrics.json", new TextEncoder().encode(FILE).buffer, "application/json");
    await scoped.put("bad.metrics.json", new TextEncoder().encode("{").buffer, "application/json");
    const m = await loadMetrics(blobs.store, acme.org.id, "m.metrics.json");
    expect(m?.root).toBe("button");
    expect(Object.keys(m?.parts ?? {})).toEqual(["button", "button.label"]);
    expect(await loadMetrics(blobs.store, acme.org.id, null)).toBeNull();
    expect(await loadMetrics(blobs.store, acme.org.id, "gone.metrics.json")).toBeNull();
    expect(await loadMetrics(blobs.store, acme.org.id, "bad.metrics.json")).toBeNull();
  });
});
