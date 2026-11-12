import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { uploadSnapshots } from "../src/upload.ts";
import { MAX_KNOWN } from "../src/upload-known.ts";
import { type Call, askedOf, fakeServer, metaOf } from "./fake-server.ts";
import { PNG_HEAD, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/**
 * `upload` sends only the PNGs the server does not already hold (PS-424): each shot is hashed, the
 * server names the hashes it has, and those shots go by hash with no `file` part.
 */

/** A PNG whose bytes (so its hash) are its own for each `n`. */
const distinct = (n: number) => new Uint8Array([...PNG_HEAD.slice(0, 8), n & 255, n >> 8]);

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");
const filesOf = (calls: Call[]) =>
  puts(calls).map((c) => (c.body instanceof FormData ? c.body.get("file") : undefined));
const knownCalls = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/known"));

async function run(fetch: (u: string, i?: RequestInit) => Promise<Response>, apart = false) {
  const { dir: cwd } = await repo(1, 1);
  const entries = [entry("home"), entry("pricing")];
  const dir = await snapshotDir(entries);
  if (apart) await Promise.all(entries.map((e, i) => Bun.write(join(dir, e.file), distinct(i))));
  const warnings: string[] = [];
  const upload = () =>
    uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch, warn: (m) => warnings.push(m), env: {}, sleep: async () => {} },
    );
  return { upload, warnings };
}

describe("uploading the same directory twice", () => {
  test("the second upload sends no PNG: every shot goes by hash, with its meta", async () => {
    const server = fakeServer();
    const { upload, warnings } = await run(server.fetch);
    await upload();
    expect(filesOf(server.calls).every((f) => f instanceof File)).toBe(true);

    server.calls.length = 0;
    const second = await upload();
    expect(second.snapshots).toBe(2);
    expect(filesOf(server.calls)).toEqual([null, null]);
    const metas = puts(server.calls).map((c) => metaOf(c.body));
    expect(metas.map((m) => m.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "home",
      "pricing",
    ]);
    for (const m of metas)
      expect(m).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // The same hash is asked once however many shots share the image.
    expect(
      askedOf(
        knownCalls(server.calls)[0] ?? {
          method: "",
          url: "",
          auth: null,
          userAgent: null,
          body: null,
        },
      ),
    ).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  test("a first upload to a server that holds nothing sends every PNG, with no hash in the meta", async () => {
    const server = fakeServer();
    const { upload } = await run(server.fetch);
    await upload();
    expect(filesOf(server.calls).every((f) => f instanceof File)).toBe(true);
    for (const c of puts(server.calls)) expect(metaOf(c.body)).not.toHaveProperty("sha256");
  });
});

describe("a server that does not take what the client assumed", () => {
  test("an older server (404 on /known) still gets every PNG, with nothing said", async () => {
    const server = fakeServer((c) =>
      c.url.endsWith("/known") ? Response.json({ error: "not found" }, { status: 404 }) : undefined,
    );
    const { upload, warnings } = await run(server.fetch);
    await upload();
    await upload();
    expect(filesOf(server.calls).length).toBe(4);
    expect(filesOf(server.calls).every((f) => f instanceof File)).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("a /known that fails another way sends every PNG and says so once", async () => {
    const server = fakeServer((c) =>
      c.url.endsWith("/known") ? Response.json({ error: "no" }, { status: 400 }) : undefined,
    );
    const { upload, warnings } = await run(server.fetch);
    await upload();
    expect(filesOf(server.calls).every((f) => f instanceof File)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("check known images");
    expect(warnings[0]).toContain("sending every image");
  });

  test("a reply with no known list means nothing is known", async () => {
    const server = fakeServer((c) =>
      c.url.endsWith("/known") ? Response.json({ id: "x" }) : undefined,
    );
    const { upload } = await run(server.fetch);
    await upload();
    server.calls.length = 0;
    await upload();
    expect(filesOf(server.calls).every((f) => f instanceof File)).toBe(true);
  });

  test("a 409 image_unknown on a by-hash PUT sends that shot again with its file", async () => {
    // /known says it holds everything; the PUT then finds nothing (what held it was swept).
    const server = fakeServer((c) =>
      c.url.endsWith("/known") ? Response.json({ known: askedOf(c) }) : undefined,
    );
    const { upload, warnings } = await run(server.fetch, true);
    const done = await upload();
    expect(done.snapshots).toBe(2);
    const sent = filesOf(server.calls);
    // Each shot went by hash, was refused, and went again with its file.
    expect(sent).toHaveLength(4);
    expect(sent.filter((f) => f instanceof File)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  test("any other error on a by-hash PUT still fails the upload", async () => {
    const server = fakeServer((c) => {
      if (c.url.endsWith("/known")) return Response.json({ known: askedOf(c) });
      return c.method === "PUT"
        ? Response.json({ error: "build is finalised" }, { status: 409 })
        : undefined;
    });
    const { upload } = await run(server.fetch);
    await expect(upload()).rejects.toThrow(/409 build is finalised/);
  });
});

describe("the hashes are asked in calls of at most MAX_KNOWN", () => {
  test("one more than the cap is two calls, each hash once", async () => {
    const count = MAX_KNOWN + 1;
    const { dir: cwd } = await repo(1, 1);
    const entries = Array.from({ length: count }, (_, i) => entry(`shot-${i}`));
    const dir = await snapshotDir(entries);
    // Every image distinct, so every hash is.
    await Promise.all(entries.map((e, i) => Bun.write(join(dir, e.file), distinct(i))));
    const server = fakeServer();
    await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server.fetch, env: {}, sleep: async () => {} },
    );
    const asked = knownCalls(server.calls).map((c) => askedOf(c));
    expect(asked.map((a) => a.length)).toEqual([MAX_KNOWN, 1]);
    expect(new Set(asked.flat()).size).toBe(count);
  }, 60_000);
});
