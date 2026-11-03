import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { snapshots } from "#/db/schema";
import { get } from "./test-read";
import { META, call, openBuild, setup, snapshotForm } from "./test-support";

/** Native snapshots (PS-293): android and ios, the device label in the browser column. */

const PIXEL = {
  ...META,
  platform: "android",
  browser: "Pixel 8 API 35",
  viewport: "412x915",
  fingerprint: {
    image: "external",
    browser: "external",
    fonts: "unknown",
    platform: "android",
    device: "Pixel 8 API 35",
    scale: "2.625",
  },
};

const put = (deps: Parameters<typeof call>[0], id: string, token: string, meta: object) =>
  call(deps, `PUT /api/v1/builds/${id}/snapshots`, token, snapshotForm(meta));

describe("native snapshots", () => {
  test("an android shot is stored with the device as its browser, and its fingerprint carries the native fields", async () => {
    const { db, deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    expect((await put(deps, id, acme.token, PIXEL)).status).toBe(200);
    expect((await put(deps, id, acme.token, META)).status).toBe(200);

    const rows = await db.select().from(snapshots).where(eq(snapshots.buildId, id));
    const android = rows.find((r) => r.platform === "android");
    const web = rows.find((r) => r.platform === "linux");
    expect(android).toMatchObject({ browser: "Pixel 8 API 35", viewport: "412x915" });
    expect(JSON.parse(android?.envFingerprint ?? "")).toEqual(PIXEL.fingerprint);
    // A web fingerprint is stored exactly as before: three fields, no native keys.
    expect(JSON.parse(web?.envFingerprint ?? "")).toEqual(META.fingerprint);
    expect(Object.keys(JSON.parse(web?.envFingerprint ?? ""))).toEqual([
      "image",
      "browser",
      "fonts",
    ]);
  });

  test("a device label is allowed for a native platform only, and a bad one is a 400", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    // A web browser stays a token.
    expect((await put(deps, id, acme.token, { ...META, browser: "my browser" })).status).toBe(400);
    for (const device of ["<b>", " Pixel", "", "x".repeat(81)]) {
      const res = await put(deps, id, acme.token, { ...PIXEL, browser: device });
      expect([device, res.status]).toEqual([device, 400]);
    }
    const badScale = { ...PIXEL, fingerprint: { ...PIXEL.fingerprint, scale: "big" } };
    expect((await put(deps, id, acme.token, badScale)).status).toBe(400);
  });

  test("the read API shows device and scale for a native shot, and null for web", async () => {
    const { deps, acme } = await setup();
    const id = await openBuild(deps, acme.token);
    await put(deps, id, acme.token, PIXEL);
    await put(deps, id, acme.token, META);
    await call(
      deps,
      `POST /api/v1/builds/${id}/finalize`,
      acme.token,
      JSON.stringify({ snapshots: 2 }),
    );
    const res = await get(deps, `/api/v1/builds/${id}`, acme.token);
    expect(res.status).toBe(200);
    const shots: {
      platform: string;
      browser: string;
      device: string | null;
      scale: number | null;
    }[] = res.body.build.snapshots;
    const android = shots.find((s) => s.platform === "android");
    const web = shots.find((s) => s.platform === "linux");
    expect(android).toMatchObject({
      browser: "Pixel 8 API 35",
      device: "Pixel 8 API 35",
      scale: 2.625,
    });
    expect(web).toMatchObject({ browser: "chromium", device: null, scale: null });
  });
});
