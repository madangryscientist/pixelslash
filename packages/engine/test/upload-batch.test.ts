import { createHash } from "node:crypto";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { uploadSnapshots } from "../src/upload.ts";
import { MAX_BATCH, sendsOnlyMeta } from "../src/upload-batch.ts";
import { type Call, askedOf, batchedOf, fakeServer, metaOf } from "./fake-server.ts";
import { FP, PNG_HEAD, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/**
 * Held, unchanged shots are registered in batches, and a baseline with the shot's own bytes is not
 * fetched: `POST /builds/:id/snapshots/batch` takes up to MAX_BATCH shots, names what it lacks, and
 * those shots go again by PUT with their file.
 */

/** A PNG whose bytes (so its hash) are its own for each `n`. */
const distinct = (n: number) => new Uint8Array([...PNG_HEAD.slice(0, 8), n & 255, n >> 8]);
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A real 16x16 PNG, with a red square when `marked`: what a diff can decode. */
function png(marked = false): Buffer {
  const img = new PNG({ width: 16, height: 16 });
  img.data.fill(255);
  if (marked)
    for (let y = 4; y < 12; y++)
      for (let x = 4; x < 12; x++) img.data.set([220, 30, 30, 255], (y * 16 + x) << 2);
  return PNG.sync.write(img);
}

const names = (count: number) => Array.from({ length: count }, (_, i) => `shot-${i}`);

async function dirOf(shots: string[], bytes: (i: number) => Uint8Array = distinct) {
  const entries = shots.map((n) => entry(n));
  const dir = await snapshotDir(entries);
  await Promise.all(entries.map((e, i) => Bun.write(join(dir, e.file), bytes(i))));
  return { dir, entries };
}

/** The `known` answer that claims every hash it is asked about, held or not. */
const claimsAll = (c: Call) =>
  c.url.endsWith("/known") ? Response.json({ known: askedOf(c) }) : undefined;

/**
 * A server that picks, for every key, a baseline of `bytes` whose hash it states as `sha256`
 * (`undefined` leaves the field out), and serves those bytes.
 */
function picking(where: "ci" | "server", baseline: Buffer, sha256: string | null | undefined) {
  return (c: Call): Response | undefined => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: where }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const keys: unknown =
        typeof c.body === "object" && c.body !== null && Reflect.get(c.body, "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      return Response.json({
        api_version: 1,
        diff_location: where,
        baselines: keys.map((key) => ({
          key,
          baseline: {
            id: "s0",
            image_url: "/images/orgs/o/s0.png?exp=1&sig=s",
            fingerprint: FP,
            ignore: [],
            ...(sha256 === undefined ? {} : { sha256 }),
          },
          carry: null,
          accepted: null,
        })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(baseline);
    return undefined;
  };
}

const batches = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/snapshots/batch"));
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
const images = (calls: Call[]) => calls.filter((c) => c.url.includes("/images/"));
const fileOf = (c: Call) => (c.body instanceof FormData ? c.body.get("file") : undefined);
const finalised = (calls: Call[]) => {
  const body = calls.find((c) => c.url.endsWith("/finalize"))?.body;
  return typeof body === "object" && body !== null ? Reflect.get(body, "snapshots") : undefined;
};

async function uploader(fetch: (u: string, i?: RequestInit) => Promise<Response>, dir: string) {
  const { dir: cwd } = await repo(1, 1);
  const warnings: string[] = [];
  const upload = () =>
    uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd), flakeRetries: 1 },
      {
        fetch,
        recapture: async () => ({ png: png(), ignore: [], media: [] }),
        warn: (m) => warnings.push(m),
        env: {},
        sleep: async () => {},
      },
    );
  return { upload, warnings };
}

describe("a baseline with the shot's own bytes", () => {
  test("is not fetched, and every held shot is registered in batches of MAX_BATCH with no PUT", async () => {
    const count = MAX_BATCH + 1;
    const { dir, entries } = await dirOf(names(count));
    // Every shot's baseline hash is its own: the pick names one hash, so use one image for all.
    const same = distinct(0);
    await Promise.all(entries.map((e) => Bun.write(join(dir, e.file), same)));
    const server = fakeServer(picking("server", Buffer.from(same), sha256Of(same)), {
      batch: true,
    });
    const { upload, warnings } = await uploader(server.fetch, dir);
    await upload();
    // The first upload holds nothing: every shot goes by its own PUT with its file, and nothing is fetched.
    expect(images(server.calls)).toHaveLength(0);
    expect(batches(server.calls)).toHaveLength(0);
    expect(puts(server.calls).every((c) => fileOf(c) instanceof File)).toBe(true);
    expect(puts(server.calls)).toHaveLength(count);

    server.calls.length = 0;
    await upload();
    expect(images(server.calls)).toHaveLength(0);
    expect(puts(server.calls)).toHaveLength(0);
    const sizes = batches(server.calls).map((c) => batchedOf(c).length);
    expect(sizes).toEqual([MAX_BATCH, 1]);
    for (const c of batches(server.calls))
      for (const m of batchedOf(c)) expect(m.sha256).toBe(sha256Of(same));
    expect(finalised(server.calls)).toBe(count);
    expect(warnings).toEqual([]);
  }, 60_000);

  test("is still fetched when the pick carries no hash, or a hash that differs", async () => {
    for (const sha of [undefined, null, "0".repeat(64)]) {
      const same = png();
      const { dir } = await dirOf(names(2), () => same);
      const server = fakeServer(picking("server", same, sha), { batch: true });
      const { upload } = await uploader(server.fetch, dir);
      await upload();
      // Both shots share one image, so one fetch per shot; none is skipped.
      expect(images(server.calls)).toHaveLength(2);
    }
  });

  test("a CI project still fetches the baseline and sends its result and mask", async () => {
    const same = png();
    const { dir } = await dirOf(names(1), () => same);
    const server = fakeServer(picking("ci", same, sha256Of(same)), { batch: true });
    const { upload } = await uploader(server.fetch, dir);
    await upload();
    expect(images(server.calls)).toHaveLength(1);
    const [put] = puts(server.calls);
    expect(metaOf(put?.body).ci?.results).toHaveLength(1);
    expect(batches(server.calls)).toHaveLength(0);
  });
});

describe("a batch that names a hash the server no longer holds", () => {
  test("stores the rest, and the CLI sends that shot by PUT with its file", async () => {
    const first = await dirOf(names(2));
    const both = await dirOf(names(3));
    const server = fakeServer(claimsAll, { batch: true });
    const one = await uploader(server.fetch, first.dir);
    await one.upload();

    server.calls.length = 0;
    const two = await uploader(server.fetch, both.dir);
    const done = await two.upload();
    expect(done.snapshots).toBe(3);
    // Shot 2's image was claimed by /known but never held: only it goes by PUT, with its file.
    const [batch] = batches(server.calls);
    expect(batchedOf(batch)).toHaveLength(3);
    const sent = puts(server.calls);
    expect(sent).toHaveLength(1);
    expect(metaOf(sent[0]?.body).name).toBe("shot-2");
    expect(sent[0] && fileOf(sent[0])).toBeInstanceOf(File);
    expect(finalised(server.calls)).toBe(3);
  });
});

describe("a server with no batch endpoint", () => {
  test("gets one attempt, then every shot by its own PUT by hash, with nothing said", async () => {
    const { dir } = await dirOf(names(3));
    const server = fakeServer(claimsAll);
    const first = await uploader(server.fetch, dir);
    await first.upload();

    server.calls.length = 0;
    const second = await uploader(server.fetch, dir);
    await second.upload();
    expect(batches(server.calls)).toHaveLength(1);
    expect(puts(server.calls)).toHaveLength(3);
    // Held images go by hash here too: no file part.
    for (const c of puts(server.calls)) expect(fileOf(c)).toBeNull();
    expect(second.warnings).toEqual([]);
  });
});

describe("a shot that sends more than its meta", () => {
  test("is registered in a batch only with no results, flake record or metrics file", () => {
    expect(sendsOnlyMeta({ results: [] })).toBe(true);
    expect(sendsOnlyMeta({ results: [], flake: { flaky: false } })).toBe(true);
    expect(sendsOnlyMeta({ results: [{}] })).toBe(false);
    expect(sendsOnlyMeta({ results: [], flake: { flaky: true } })).toBe(false);
    expect(sendsOnlyMeta({ results: [], metrics: Buffer.from("{}") })).toBe(false);
  });
});
