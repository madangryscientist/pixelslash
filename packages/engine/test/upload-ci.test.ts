import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { type BaselinePick, ENGINE_VERSION, measureShot } from "../src/ci-diff.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { FP, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/** A 16x16 white PNG, with a red square at (4, 4) when `marked`. */
function png(marked = false): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(255);
  if (marked)
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++) img.data.set([220, 30, 30, 255], (y * 16 + x) << 2);
  return PNG.sync.write(img);
}

const picked = (id: string) => ({
  id,
  image_url: `/images/orgs/o/${id}.png?exp=1&sig=s`,
  fingerprint: FP,
  ignore: [],
});

const shot = { diff: {}, ignore: [] };

const fetchPng = (images: Record<string, Buffer>) => async (p: { id: string }) => {
  const bytes = images[p.id];
  if (!bytes) throw new Error(`no ${p.id}`);
  return bytes;
};

/** The form a PUT sent; the upload always sends one. */
function formOf(call: Call | undefined): FormData {
  if (!(call?.body instanceof FormData)) throw new Error("no form sent");
  return call.body;
}

/** The shot keys a baselines request asked for. */
function keysOf(body: unknown): unknown[] {
  const keys: unknown = typeof body === "object" && body !== null && Reflect.get(body, "keys");
  if (!Array.isArray(keys)) throw new Error("no keys sent");
  return keys;
}

describe("measureShot measures against what the server named", () => {
  test("no baseline measures nothing; a plain baseline gives one result", async () => {
    const none: BaselinePick = { baseline: null, carry: null, accepted: null };
    expect(await measureShot(shot, png(), none, fetchPng({}))).toEqual([]);
    const pick = { ...none, baseline: picked("b") };
    const [r, ...rest] = await measureShot(shot, png(true), pick, fetchPng({ b: png() }));
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ baselineId: "b", status: "changed" });
    expect(r?.diffResult.changedPixels).toBeGreaterThan(0);
  });

  test("a carry measures both the carried change and accepted, whatever the shot", async () => {
    const pick = { baseline: picked("b"), carry: "b", accepted: picked("a") };
    const both = await measureShot(shot, png(true), pick, fetchPng({ b: png(true), a: png() }));
    expect(both.map((r) => [r.baselineId, r.status])).toEqual([
      ["b", "unchanged"],
      ["a", "changed"],
    ]);
    const same = { ...pick, accepted: picked("b") };
    expect(await measureShot(shot, png(), same, fetchPng({ b: png() }))).toHaveLength(1);
  });
});

/** A server whose project diffs at `where`, holding one baseline for every shot. */
function server(where: "ci" | "server") {
  const baseline = png();
  const fake = fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: where }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const keys = keysOf(c.body);
      return Response.json({
        api_version: 1,
        diff_location: where,
        baselines: keys.map((key) => ({
          key,
          baseline: picked("s0"),
          carry: null,
          accepted: null,
        })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(baseline);
    return undefined;
  });
  return fake;
}

async function upload(where: "ci" | "server") {
  const { dir: cwd } = await repo(1, 1);
  const dir = await snapshotDir([entry("home")]);
  await Bun.write(join(dir, "home/desktop.png"), png(true));
  const fake = server(where);
  await uploadSnapshots(
    { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
    { fetch: fake.fetch },
  );
  return fake.calls;
}

describe("uploadSnapshots to a project that diffs in CI (ob 1727)", () => {
  test("says it can diff, fetches the pick, and sends its result with the mask", async () => {
    const calls = await upload("ci");
    expect(calls[0]?.body).toMatchObject({ clientDiff: true });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/v1/builds",
      "POST /api/v1/builds/b1/baselines",
      "GET /images/orgs/o/s0.png",
      "PUT /api/v1/builds/b1/snapshots",
      "POST /api/v1/builds/b1/finalize",
    ]);
    const put = calls.find((c) => c.method === "PUT");
    const meta = metaOf(put?.body);
    expect(meta.ci?.engineVersion).toBe(ENGINE_VERSION);
    expect(meta.ci?.results).toEqual([
      expect.objectContaining({ baselineId: "s0", status: "changed" }),
    ]);
    expect(formOf(put).get("diff:s0")).toBeInstanceOf(File);
  });

  test("a server project still gets its pick fetched, but nothing is diffed or sent", async () => {
    const calls = await upload("server");
    expect(calls.some((c) => c.url.includes("/images/"))).toBe(false);
    const put = calls.find((c) => c.method === "PUT");
    expect(metaOf(put?.body)).not.toHaveProperty("ci");
    expect(formOf(put).has("diff:s0")).toBe(false);
  });
});
