import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, test } from "vitest";
import { ENGINE_VERSION } from "../src/ci-diff.ts";
import type { Shoot, SnapshotEntry } from "../src/snapshot.ts";
import { uploadSnapshots } from "../src/upload.ts";
import { type Call, fakeServer, metaOf } from "./fake-server.ts";
import { FP, cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

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

/** A project that diffs at `where` and holds a plain white baseline for every shot. */
function server(where: "ci" | "server") {
  return fakeServer((c: Call) => {
    if (c.method === "POST" && c.url.endsWith("/api/v1/builds"))
      return Response.json({ id: "b1", diffLocation: where }, { status: 201 });
    if (c.url.endsWith("/baselines")) {
      const body = c.body;
      const keys: unknown = typeof body === "object" && body !== null && Reflect.get(body, "keys");
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      return Response.json({
        api_version: 1,
        diff_location: where,
        baselines: keys.map((key) => ({ key, baseline: picked, carry: null, accepted: null })),
      });
    }
    if (c.method === "GET" && c.url.includes("/images/")) return new Response(png());
    return undefined;
  });
}

/**
 * Three shots against a white baseline: `same` is white too, `real` has the square at 4 in every
 * capture, `flicker` has it at 4 first and at 4, 16 on its re-captures (run 3 moved).
 */
async function upload(opts: { where?: "ci" | "server"; retries?: number; flaky?: string } = {}) {
  const { dir: cwd } = await repo(1, 1);
  const flicker = entry("flicker", "desktop", opts.flaky ? { flaky: opts.flaky } : {});
  const dir = await snapshotDir([entry("same"), entry("real"), flicker]);
  await Bun.write(join(dir, "same/desktop.png"), png());
  await Bun.write(join(dir, "real/desktop.png"), png(4));
  await Bun.write(join(dir, "flicker/desktop.png"), png(4));
  const flickers = [png(4), png(16)];
  const asked: string[] = [];
  let busy = 0;
  let overlapped = false;
  const recapture = async (e: SnapshotEntry): Promise<Shoot> => {
    asked.push(e.name);
    overlapped ||= busy > 0;
    busy++;
    await Bun.sleep(5);
    busy--;
    const bytes = e.name === "flicker" ? flickers.shift() : png(4);
    if (!bytes) throw new Error("re-captured too often");
    return { png: bytes, ignore: [], media: [] };
  };
  const fake = server(opts.where ?? "server");
  const result = await uploadSnapshots(
    {
      dir,
      server: "https://ps.example",
      token: "psci_t",
      git: gitOpts(cwd),
      ...(opts.retries !== undefined && { flakeRetries: opts.retries }),
    },
    { fetch: fake.fetch, recapture },
  );
  const puts = new Map(
    fake.calls
      .filter((c) => c.method === "PUT")
      .map((c) => [metaOf(c.body).name, c.body instanceof FormData ? c.body : new FormData()]),
  );
  return { dir, result, asked, puts, overlapped: () => overlapped };
}

const metaFor = (puts: Map<string, FormData>, name: string) => metaOf(puts.get(name));

describe("a changed shot is captured again, and a flaky one says so (ob 1737)", () => {
  test("only changed shots are re-captured, each the default 2 more times, one at a time", async () => {
    const { asked, overlapped } = await upload();
    expect(asked.toSorted()).toEqual(["flicker", "flicker", "real", "real"]);
    expect(overlapped()).toBe(false);
  });

  test("every shot sends its resolved policy, flaky or not", async () => {
    const { puts } = await upload({ flaky: "skip" });
    expect(Reflect.get(metaFor(puts, "same"), "flaky")).toBe("review");
    expect(Reflect.get(metaFor(puts, "flicker"), "flaky")).toBe("skip");
  });

  test("the flaky shot alone sends its record, its runs and its policy", async () => {
    const { puts, result } = await upload({ flaky: "skip" });
    const meta = metaFor(puts, "flicker");
    expect(Reflect.get(meta, "flake")).toEqual({
      runs: 3,
      differed: [3],
      regions: [{ run: 3, regions: [expect.objectContaining({ kind: "change" })] }],
      engineVersion: ENGINE_VERSION,
      policy: "skip",
    });
    const form = puts.get("flicker");
    expect(form?.get("flake:2")).toBeInstanceOf(File);
    expect(form?.get("flake:3")).toBeInstanceOf(File);
    for (const name of ["same", "real"]) {
      expect(metaFor(puts, name)).not.toHaveProperty("flake");
      expect([...(puts.get(name)?.keys() ?? [])].toSorted()).toEqual(["file", "meta"]);
    }
    expect(result.flaky.map((f) => f.entry.name)).toEqual(["flicker"]);
    expect(result.changed.map((e) => e.name)).toEqual(["real"]);
  });

  test("a server project's local diff decides the retries and is never sent", async () => {
    const { puts } = await upload({ where: "server" });
    for (const name of ["same", "real", "flicker"]) {
      expect(metaFor(puts, name)).not.toHaveProperty("ci");
      expect(puts.get(name)?.has("diff:s0")).toBe(false);
    }
  });

  test("a CI project sends its diff results as before, and the record beside them", async () => {
    const { puts } = await upload({ where: "ci" });
    const meta = metaFor(puts, "flicker");
    expect(meta.ci?.results).toEqual([expect.objectContaining({ status: "changed" })]);
    expect(Reflect.get(meta, "flake")).toMatchObject({ runs: 3, policy: "review" });
  });

  test("0 retries captures each shot once and writes no report", async () => {
    const { asked, puts, result } = await upload({ retries: 0 });
    expect(asked).toEqual([]);
    expect(metaFor(puts, "flicker")).not.toHaveProperty("flake");
    expect(result.report).toBeUndefined();
  });

  test("the local report names the flaky shot, its runs and its policy", async () => {
    const { dir, result } = await upload();
    expect(result.report).toBe(join(dir, "report.html"));
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("flaky: 1 of 3 runs differed");
    expect(html).toContain("policy: <b>review</b>");
    expect(html).toContain('src="flicker/desktop.png"');
    expect(html).toContain('src="@flake/flicker/desktop.run3.png"');
    expect(html).toContain("Changed, every run agreed (1)");
    expect(await Bun.file(join(dir, "@flake/flicker/desktop.run2.png")).exists()).toBe(true);
  });

  test("a re-capture that fails is said, and the shot goes up as captured", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("real")]);
    await Bun.write(join(dir, "real/desktop.png"), png(4));
    const fake = server("server");
    const warnings: string[] = [];
    const result = await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      {
        fetch: fake.fetch,
        warn: (m) => warnings.push(m),
        recapture: async () => undefined,
      },
    );
    expect(warnings).toEqual([
      expect.stringContaining("real / chromium / 1280x720 / light: not captured again"),
    ]);
    expect(result.flaky).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((k) => k.entry.name)).toEqual(["real"]);
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("Changed, not captured again (1)");
    expect(html).toContain("the config has no such route or variant");
    expect(html).not.toContain("none differed");
  });

  test("an earlier run's report and runs go, and a route called flake keeps its shots", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("flake")]);
    await Bun.write(join(dir, "flake/desktop.png"), png());
    await Bun.write(join(dir, "report.html"), "stale");
    await Bun.write(join(dir, "@flake/old/desktop.run2.png"), png());
    const result = await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd), flakeRetries: 0 },
      { fetch: server("server").fetch },
    );
    expect(result.report).toBeUndefined();
    expect(await Bun.file(join(dir, "report.html")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "@flake/old/desktop.run2.png")).exists()).toBe(false);
    expect(await Bun.file(join(dir, "flake/desktop.png")).exists()).toBe(true);
  });

  test("with nothing changed the report says how many shots were measured", async () => {
    const { dir: cwd } = await repo(1, 1);
    const dir = await snapshotDir([entry("same")]);
    await Bun.write(join(dir, "same/desktop.png"), png());
    await uploadSnapshots(
      { dir, server: "https://ps.example", token: "psci_t", git: gitOpts(cwd) },
      { fetch: server("server").fetch, recapture: async () => undefined },
    );
    const html = await Bun.file(join(dir, "report.html")).text();
    expect(html).toContain("All 1 shots were measured against their baseline; none differed");
  });
});
