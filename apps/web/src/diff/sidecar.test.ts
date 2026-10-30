import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  type DiffIgnore,
  type DiffOptions,
  type PixelDiff,
  diffPngs,
} from "@hackcove/pixelslash-engine/diff";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { png } from "../../e2e/png";
import { resetFallbackLog, sidecarDiff, sidecarEndpoint } from "./sidecar";
import { context, onlyShot, sha, upload } from "./test-builds";
import { RED, shot } from "./test-shots";

/**
 * The self-host's diff sidecar (PS-203) against the in-process diff. The real sidecar runs as its
 * own process, as systemd runs it. Both run `diff.wasm` (PS-210), so every field of the result is
 * held equal, the overlay's bytes included.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");

let sidecar: ReturnType<typeof Bun.spawn> | undefined;
let url = "";

beforeAll(async () => {
  const proc = Bun.spawn(["bun", "deploy/ssh/diff-sidecar.ts"], {
    cwd: join(import.meta.dirname, "..", ".."),
    env: { ...process.env, PIXELSLASH_DIFF_SIDECAR_PORT: "0" },
    stdout: "pipe",
    stderr: "inherit",
  });
  sidecar = proc;
  const reader = proc.stdout.getReader();
  let said = "";
  while (!said.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the sidecar exited before it listened: ${said}`);
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  // Its per-diff log lines are drained, so a full pipe never stalls it.
  void proc.stdout.pipeTo(new WritableStream());
  if (!said.includes("(diff.wasm)")) throw new Error(`the sidecar did not say its engine: ${said}`);
  url = /http:\/\/127\.0\.0\.1:\d+/.exec(said)?.[0] ?? "";
  if (!url) throw new Error(`the sidecar did not say where it listens: ${said}`);
}, 30_000);

afterAll(() => {
  sidecar?.kill();
});

/** The client for a sidecar at `base`, which the tests only ever start on loopback. */
function client(base: string, deps: { timeoutMs?: number } = {}) {
  const endpoint = sidecarEndpoint(base);
  if (!endpoint) throw new Error(`${base} is not a loopback sidecar`);
  return sidecarDiff(endpoint, deps);
}

const hash = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/** The result with the overlay as its hash: what the sidecar must give the in-process diff's. */
function comparable({ overlay, ...fields }: PixelDiff) {
  return { ...fields, overlay: overlay ? hash(overlay) : null };
}

/** A real changed pair: the transport carries a drawn overlay and its regions intact. */
const CORPUS = join(ROOT, "bench/corpus/real-colour-badge");

describe("the sidecar gives the in-process result (PS-203)", () => {
  test("on a bench corpus pair", async () => {
    const main = readFileSync(join(CORPUS, "base.png"));
    const branch = readFileSync(join(CORPUS, "head.png"));
    const got = await client(url)(main, branch, {}, {});
    expect(got.overlay).toBeTruthy();
    expect(comparable(got)).toEqual(comparable(diffPngs(main, branch)));
  });

  // The e2e uploads' own fixtures, with the options and ignore areas a shot can carry, which the
  // corpus pairs do not.
  const red: [number, number, number] = [220, 30, 30];
  type Case = {
    name: string;
    main: Buffer;
    branch: Buffer;
    options?: DiffOptions;
    ignore?: DiffIgnore;
  };
  const block = { x: 40, y: 40, w: 60, h: 30, rgb: red };
  const cases: Case[] = [
    {
      name: "a block under an ignore area",
      main: png(320, 200, [], 2),
      branch: png(320, 200, [block], 2),
      ignore: {
        main: [{ x: 30, y: 30, width: 80, height: 50 }],
        branch: [{ x: 30, y: 30, width: 80, height: 50 }],
      },
    },
    {
      name: "thresholds and floors",
      main: png(320, 200, [], 3),
      branch: png(320, 200, [{ x: 10, y: 10, w: 8, h: 8, rgb: red }], 3),
      options: { threshold: 0.3, minChangedPixels: 100, minChangedRatio: 0.01 },
    },
  ];
  test.each(cases)(
    "on the e2e fixtures: $name",
    async ({ main, branch, options = {}, ignore = {} }) => {
      const got = await client(url)(main, branch, options, ignore);
      expect(comparable(got)).toEqual(comparable(diffPngs(main, branch, options, ignore)));
    },
  );
});

describe("a build falls back to the in-process diff (PS-203)", () => {
  const W = 120;
  const H = 80;
  const main = shot({ width: W, height: H });
  const branch = shot({ width: W, height: H, blocks: [{ x: 10, y: 10, w: 30, h: 20, rgb: RED }] });

  /** Upload main and a changed branch with `diffSidecar`; what the branch's shot holds. */
  async function measured(diffSidecar: string | undefined) {
    const ctx = await context();
    await upload(ctx, { branch: "main", commit: sha(1), shots: [{ png: main }] }, { diffSidecar });
    const build = await upload(
      ctx,
      { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: [{ png: branch }] },
      { diffSidecar },
    );
    const held = await onlyShot(ctx, build);
    return { status: build.status, diffStatus: held.diffStatus, diffResult: held.diffResult };
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetFallbackLog();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return () => warn.mockRestore();
  });

  const fallbacks = () =>
    warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l: string) => l.startsWith("server diff:"));

  test("through the sidecar, the build records what pngjs measures", async () => {
    const want = await measured(undefined);
    resetFallbackLog();
    warn.mockClear();
    expect(await measured(url)).toEqual(want);
    expect(want.diffStatus).toBe("changed");
    expect(fallbacks()).toEqual([]);
  });

  test("unset: measured in-process, said once", async () => {
    const got = await measured(undefined);
    expect(got.diffStatus).toBe("changed");
    expect(fallbacks()).toEqual([expect.stringContaining("in-process (unset)")]);
  });

  test("not on loopback: refused, measured in-process, said once", async () => {
    for (const elsewhere of ["http://192.0.2.1:4181", "https://localhost:4181", "127.0.0.1:4181"])
      expect(sidecarEndpoint(elsewhere)).toBeNull();
    const want = await measured(undefined);
    resetFallbackLog();
    warn.mockClear();
    expect(await measured("http://192.0.2.1:4181")).toEqual(want);
    expect(fallbacks()).toEqual([expect.stringContaining("in-process (refused)")]);
  });

  test("down: measured in-process, said once, and not tried again that run", async () => {
    // Takes each connection and drops it, as a sidecar that died mid-burst would, counting them.
    let connections = 0;
    const dropping = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
    const address = dropping.address();
    const dead = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const ctx = await context();
      const names = ["a", "b", "c"];
      const shots = (image: Uint8Array<ArrayBuffer>) => names.map((name) => ({ name, png: image }));
      await upload(
        ctx,
        { branch: "main", commit: sha(1), shots: shots(main) },
        { diffSidecar: dead },
      );
      const build = await upload(
        ctx,
        { branch: "feat/x", commit: sha(2), mergeBase: sha(1), shots: shots(branch) },
        { diffSidecar: dead },
      );
      expect(build.status).not.toBe("errored");
      expect(fallbacks()).toEqual([expect.stringContaining("in-process (unreachable)")]);
      // Three shots measured, and the sidecar tried for the first only.
      expect(connections).toBe(1);
    } finally {
      await new Promise((resolve) => dropping.close(resolve));
    }
  });

  test("an error reply: measured in-process, said once", async () => {
    const failing = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("boom", { status: 500 }),
    });
    try {
      const want = await measured(undefined);
      resetFallbackLog();
      warn.mockClear();
      expect(await measured(`http://127.0.0.1:${failing.port}`)).toEqual(want);
      expect(fallbacks()).toEqual([expect.stringContaining("in-process (error): ")]);
      expect(fallbacks()[0]).toContain("HTTP 500 boom");
    } finally {
      await failing.stop(true);
    }
  });

  test("a file the sidecar rejects: measured in-process, not logged", async () => {
    // The real sidecar answers a PNG it cannot read with 422 ...
    await expect(
      client(url)(Buffer.from("not a png"), Buffer.from(branch), {}, {}),
    ).rejects.toMatchObject({ name: "SidecarError", kind: "rejected" });
    // ... which pngjs then measures, and reports in its own words if it cannot either.
    const rejecting = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ error: "bad png" }, { status: 422 }),
    });
    try {
      const want = await measured(undefined);
      resetFallbackLog();
      warn.mockClear();
      expect(await measured(`http://127.0.0.1:${rejecting.port}`)).toEqual(want);
      expect(fallbacks()).toEqual([]);
    } finally {
      await rejecting.stop(true);
    }
  });

  test("a hung sidecar times out as unreachable", async () => {
    const hung = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      await expect(
        client(`http://127.0.0.1:${hung.port}`, { timeoutMs: 200 })(
          Buffer.from(main),
          Buffer.from(branch),
          {},
          {},
        ),
      ).rejects.toMatchObject({ name: "SidecarError", kind: "unreachable" });
    } finally {
      await hung.stop(true);
    }
  });
});
