import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { identity, readManifest } from "../src/manifest.ts";
import type { Shoot, SnapshotEntry } from "../src/snapshot.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { FP, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/**
 * The upload's half of reusing preview pages (PS-445): a shot taken on a reused page is kept only
 * when it is byte for byte its baseline. Anything else, a change or a shot with no baseline, is shot
 * again on a fresh page, and that PNG is the shot from then on.
 */

/** A 32x32 white PNG, with an 8px red square at (`at`, 4) when `at` is given. */
function png(at?: number): Buffer {
  const img = new PNG({ width: 32, height: 32 });
  img.data.fill(255);
  if (at !== undefined)
    for (let y = 4; y < 12; y++)
      for (let x = at; x < at + 8; x++) img.data.set([220, 30, 30, 255], (y * 32 + x) << 2);
  return PNG.sync.write(img);
}

const picked = {
  id: "s0",
  image_url: "/images/orgs/o/s0.png?exp=1&sig=s",
  fingerprint: FP,
  ignore: [],
};

/** A project that holds a white baseline for every shot but `fresh-story`, which is new. */
function server() {
  return fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: "server" }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const keys: unknown = Reflect.get(Object(c.body), "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      return Response.json({
        api_version: 1,
        diff_location: "server",
        baselines: keys.map((key) => ({
          key,
          baseline: JSON.stringify(key).includes("fresh-story") ? null : picked,
          carry: null,
          accepted: null,
        })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(png());
    return undefined;
  });
}

/** What each shot's reused page captured, and what a fresh page captures of it. */
const SHOTS: Record<string, { reused: Buffer; fresh: Buffer }> = {
  // Byte for byte the baseline: kept as it is.
  same: { reused: png(), fresh: png() },
  // A reuse artifact: the fresh page renders the baseline.
  artifact: { reused: png(16), fresh: png() },
  // A real change: the fresh page shows it too, in another place than the reused page did.
  real: { reused: png(16), fresh: png(4) },
  // A new shot, with no baseline.
  "fresh-story": { reused: png(16), fresh: png(4) },
};

async function upload(opts: { retries?: number; reused?: string[] } = {}) {
  const { dir: cwd } = await repo(1, 1);
  const names = Object.keys(SHOTS);
  const dir = await snapshotDir(names.map((n) => entry(n)));
  for (const n of names) await Bun.write(join(dir, `${n}/desktop.png`), SHOTS[n]!.reused);
  const asked: string[] = [];
  const recapture = async (e: SnapshotEntry): Promise<Shoot> => {
    asked.push(e.name);
    return { png: SHOTS[e.name]!.fresh, ignore: [], media: [] };
  };
  const keep = opts.reused ?? names;
  const pooled = (await readManifest(dir)).snapshots.filter((e) => keep.includes(e.name));
  const fake = server();
  const result = await uploadSnapshots(
    {
      dir,
      server: "https://ps.example",
      token: "psci_t",
      git: gitOpts(cwd),
      ...(opts.retries !== undefined && { flakeRetries: opts.retries }),
    },
    {
      fetch: fake.fetch,
      recapture,
      reused: new Set(pooled.map(identity)),
    },
  );
  const sent = new Map<string, Buffer>();
  for (const put of fake.calls.filter((c) => c.method === "PUT")) {
    const file = put.body instanceof FormData ? put.body.get("file") : null;
    if (file instanceof Blob)
      sent.set(metaOf(put.body).name, Buffer.from(await file.arrayBuffer()));
  }
  const onDisk = async (n: string) =>
    Buffer.from(await Bun.file(join(dir, `${n}/desktop.png`)).bytes());
  return { result, asked, sent, onDisk };
}

describe("a shot from a reused preview page is kept only where it is its baseline (PS-445)", () => {
  test("a reused shot whose fresh shot is its baseline is uploaded unchanged, with the fresh bytes", async () => {
    const { result, asked, sent, onDisk } = await upload();
    expect(sent.get("artifact")).toEqual(png());
    expect(await onDisk("artifact")).toEqual(png());
    expect(result.changed.map((e) => e.name)).not.toContain("artifact");
    expect(result.flaky).toEqual([]);
    // One fresh shot, and no flake retries: the fresh shot equals the baseline.
    expect(asked.filter((n) => n === "artifact")).toEqual(["artifact"]);
  });

  test("a reused shot that is its baseline byte for byte is not shot again", async () => {
    const { asked, sent } = await upload();
    expect(asked).not.toContain("same");
    expect(sent.get("same")).toEqual(png());
  });

  test("a real change goes up as its fresh PNG, and the flake retries compare against that", async () => {
    const { result, asked, sent, onDisk } = await upload();
    expect(sent.get("real")).toEqual(png(4));
    expect(await onDisk("real")).toEqual(png(4));
    // The retries shoot png(4), as the fresh first did: against the reused png(16) they would be flaky.
    expect(result.flaky).toEqual([]);
    expect(result.changed.map((e) => e.name)).toEqual(["real"]);
    expect(asked.filter((n) => n === "real")).toHaveLength(1 + 2);
  });

  test("a new shot captured on a reused page goes up as a fresh PNG", async () => {
    const { asked, sent, result } = await upload();
    expect(sent.get("fresh-story")).toEqual(png(4));
    expect(asked.filter((n) => n === "fresh-story")).toEqual(["fresh-story"]);
    expect(result.reshot).toBe(3);
  });

  test("with no retries a reused shot that differs is still shot fresh, once", async () => {
    const { asked, sent } = await upload({ retries: 0 });
    expect(asked.toSorted()).toEqual(["artifact", "fresh-story", "real"]);
    expect(sent.get("artifact")).toEqual(png());
    expect(sent.get("real")).toEqual(png(4));
  });

  test("a shot not taken on a reused page is never shot fresh in its place", async () => {
    const { asked, sent, result } = await upload({ reused: [] });
    // Only the flake retries of the two that differ from the baseline; the new shot is not measured.
    expect(asked.toSorted()).toEqual(["artifact", "artifact", "real", "real"]);
    expect(sent.get("artifact")).toEqual(png(16));
    expect(result.reshot).toBe(0);
  });
});
