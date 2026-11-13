import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { CaptureError, CaptureTimeout } from "../src/errors.ts";
import { DEFAULT_CONCURRENCY_CAP, captureInto, defaultConcurrency } from "../src/capture-into.ts";
import { openCaptureSession, type CaptureSession } from "../src/snapshot.ts";
import { runIteration } from "../src/dev-run.ts";
import { cleanupDev, png, tmpDir, tmpStore } from "./dev-fixtures.ts";

afterAll(cleanupDev);

const ROUTES = ["/a", "/b", "/c", "/d", "/e"];

/** A browserless session on five routes × two variants whose shots take `ms(name)` each. */
function session(
  ms: (name: string) => number,
  fail?: string,
  concurrency?: number,
  /** Shots that throw a `CaptureTimeout` on their first `n` attempts, then succeed. */
  timeouts: Record<string, number> = {},
) {
  const config = parseConfig({
    baseUrl: "http://127.0.0.1:9",
    ...(concurrency === undefined ? {} : { concurrency }),
    routes: ROUTES,
    variants: [
      { name: "wide", viewport: { width: 16, height: 16 } },
      { name: "narrow", viewport: { width: 8, height: 16 } },
    ],
  });
  const seen = {
    running: 0,
    most: 0,
    started: [] as string[],
    /** How many shots were running (this one included) when each attempt of a timing-out shot began. */
    alongside: [] as { name: string; running: number }[],
  };
  const tries: Record<string, number> = {};
  const fake: CaptureSession = {
    config,
    routes: config.routes,
    fingerprintFor: () => ({ image: "version:test", browser: "chromium 1", fonts: "sha256:f" }),
    browserLaunchMs: 0,
    shoot: async (route, variant) => {
      const name = `${route.name}/${variant.name}`;
      seen.started.push(name);
      seen.running++;
      seen.most = Math.max(seen.most, seen.running);
      if (name in timeouts) seen.alongside.push({ name, running: seen.running });
      await Bun.sleep(ms(name));
      seen.running--;
      tries[name] = (tries[name] ?? 0) + 1;
      if (name in timeouts && tries[name] <= (timeouts[name] ?? 0))
        throw new CaptureTimeout(`story ${name} did not render within 8000ms`);
      if (name === fail) throw new CaptureError(`capture settle exceeded on ${name}`);
      return { png: png(), ignore: [], media: [] };
    },
    flush: () => {},
    close: async () => {},
  };
  return { fake, seen };
}

describe("captureInto takes shots at once (PS-195, PS-436)", () => {
  test.each([1, 6])(
    "at most %i run together, and the manifest keeps the config's order",
    async (n) => {
      // Earlier shots take longer, so they finish out of order.
      const { fake, seen } = session((name) => (name.startsWith("a") ? 60 : 5));
      const { manifest, shots } = await captureInto(fake, await tmpDir(), n);
      expect(seen.most).toBe(n);
      const order = ["wide", "narrow"].flatMap((v) => ROUTES.map((r) => `${r.slice(1)}/${v}`));
      expect(manifest.snapshots.map((e) => `${e.name}/${e.variant.name}`)).toEqual(order);
      expect(shots).toHaveLength(order.length);
    },
  );

  test("without an argument the config's concurrency is used", async () => {
    const { fake, seen } = session(() => 20, undefined, 3);
    await captureInto(fake, await tmpDir());
    expect(seen.most).toBe(3);
  });

  test("without either, the default for the machine is used", async () => {
    const { fake, seen } = session(() => 20);
    await captureInto(fake, await tmpDir(), undefined, {
      machine: { cores: 4, load: 0 },
      warn: () => {},
    });
    expect(seen.most).toBe(4);
  });

  test.each([4, 6])(
    "a failing shot starts no new shot and waits for the running ones (%i)",
    async (n) => {
      const { fake, seen } = session((name) => (name === "a/wide" ? 5 : 40), "a/wide");
      await expect(captureInto(fake, await tmpDir(), n)).rejects.toThrow(
        /settle exceeded on a\/wide/,
      );
      expect(seen.started).toHaveLength(n);
      expect(seen.running).toBe(0);
    },
  );
});

describe("defaultConcurrency", () => {
  test("is the cap on a big machine and the core count on a small one, at least 1", () => {
    expect(defaultConcurrency(64, 0)).toBe(DEFAULT_CONCURRENCY_CAP);
    expect(defaultConcurrency(2, 0)).toBe(2);
    expect(defaultConcurrency(0, 0)).toBe(1);
  });

  test.each([
    ["idle", 12, 0, 10],
    ["partly busy", 12, 6.5, 5],
    ["saturated", 12, 30, 1],
    ["just under the cores", 12, 11.2, 1],
  ])("gives way to the machine's load: %s (%i cores, load %f) takes %i", (_, cores, load, n) => {
    expect(defaultConcurrency(cores, load)).toBe(n);
  });
});

const lines = () => {
  const out: string[] = [];
  return { out, warn: (m: string) => void out.push(m) };
};

describe("captureInto says why a default count is low (PS-474)", () => {
  test("a busy machine gets the concurrency line, and the count it names", async () => {
    const { fake, seen } = session(() => 20);
    const { out, warn } = lines();
    await captureInto(fake, await tmpDir(), undefined, { machine: { cores: 12, load: 6.5 }, warn });
    expect(seen.most).toBe(5);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^concurrency: 5 \(12 CPUs, load 6\.5\)/);
  });

  test("an idle machine, a small one and a configured count print nothing", async () => {
    for (const [concurrency, machine] of [
      [undefined, { cores: 12, load: 0 }],
      [undefined, { cores: 2, load: 0 }],
      [3, { cores: 12, load: 30 }],
    ] as const) {
      const { fake } = session(() => 1, undefined, concurrency);
      const { out, warn } = lines();
      await captureInto(fake, await tmpDir(), undefined, { machine, warn });
      expect(out).toEqual([]);
    }
  });
});

describe("a shot that times out is retried alone after the run (PS-474)", () => {
  test("it is captured on the solo pass, in config order, and the run resolves", async () => {
    const { fake, seen } = session(() => 10, undefined, 4, { "b/narrow": 1 });
    const out: string[] = [];
    const { manifest } = await captureInto(fake, await tmpDir(), 4, {
      warn: (m) => void out.push(m),
    });
    const order = ["wide", "narrow"].flatMap((v) => ROUTES.map((r) => `${r.slice(1)}/${v}`));
    expect(manifest.snapshots.map((e) => `${e.name}/${e.variant.name}`)).toEqual(order);
    // First attempt in the pool, second after every other shot has finished, with nothing beside it.
    expect(seen.alongside.map((a) => a.name)).toEqual(["b/narrow", "b/narrow"]);
    expect(seen.alongside[1]?.running).toBe(1);
    expect(seen.started.at(-1)).toBe("b/narrow");
    expect(out).toEqual(["retry: 1 shot timed out under load; retried alone after the run"]);
  });

  test("several are retried one at a time, and counted", async () => {
    const { fake, seen } = session(() => 10, undefined, 5, { "a/wide": 1, "e/narrow": 1 });
    const out: string[] = [];
    await captureInto(fake, await tmpDir(), 5, { warn: (m) => void out.push(m) });
    expect(seen.alongside.slice(2).map((a) => a.running)).toEqual([1, 1]);
    expect(out).toEqual(["retry: 2 shots timed out under load; retried alone after the run"]);
  });

  test("one that times out again fails the run, naming the shot and that it was retried alone", async () => {
    const { fake, seen } = session(() => 5, undefined, 4, { "c/wide": 2 });
    const failing = captureInto(fake, await tmpDir(), 4, { warn: () => {} });
    await expect(failing).rejects.toThrow(
      /story c\/wide did not render within 8000ms; retried alone after the run and timed out again/,
    );
    expect(await failing.catch((e: unknown) => e)).toBeInstanceOf(CaptureError);
    expect(seen.running).toBe(0);
  });

  test("a clean run prints no retry line", async () => {
    const { fake } = session(() => 1, undefined, 3);
    const out: string[] = [];
    await captureInto(fake, await tmpDir(), 3, { warn: (m) => void out.push(m) });
    expect(out).toEqual([]);
  });

  test("a plain CaptureError still stops the run at once, with no solo retry", async () => {
    const { fake, seen } = session((name) => (name === "a/wide" ? 5 : 40), "a/wide", 4, {
      "e/wide": 1,
    });
    const out: string[] = [];
    await expect(
      captureInto(fake, await tmpDir(), 4, { warn: (m) => void out.push(m) }),
    ).rejects.toThrow(/settle exceeded on a\/wide/);
    expect(seen.started).toHaveLength(4);
    expect(seen.running).toBe(0);
    expect(out).toEqual([]);
  });

  test("a shot set aside is not retried when another shot then fails for good", async () => {
    // a/wide times out and is set aside; c/wide then fails with a plain error.
    const { fake, seen } = session(() => 10, "c/wide", 2, { "a/wide": 1 });
    await expect(captureInto(fake, await tmpDir(), 2, { warn: () => {} })).rejects.toThrow(
      /settle exceeded on c\/wide/,
    );
    expect(seen.alongside.filter((a) => a.name === "a/wide")).toHaveLength(1);
  });
});

describe("dev still takes one shot at a time (PS-436)", () => {
  test("a config that asks for six workers does not change a dev run", async () => {
    const { fake, seen } = session(() => 15, undefined, 6);
    await runIteration({ store: await tmpStore(), session: fake, target: "index", maxBytes: 1e9 });
    expect(seen.started).toHaveLength(ROUTES.length * 2);
    expect(seen.most).toBe(1);
  });
});

const SITE = fileURLToPath(new URL("../../../fixtures/capture/site", import.meta.url));
/** `/masks` draws random colours and text on every load; only its masks make it capture the same. */
const MASKS = [".ad", { x: 0, y: 200, width: 320, height: 40 }];

/** Every file under `dir`, relative, sorted, with the sha256 of its bytes. */
async function hashes(dir: string): Promise<Record<string, string>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name.endsWith(".png"))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .toSorted();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha256")
          .update(await Bun.file(join(dir, f)).bytes())
          .digest("hex"),
      ]),
    ),
  );
}

describe("captureInto keeps the pixels at any concurrency (real Chromium)", () => {
  let site: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const file = Bun.file(join(SITE, `${path === "/" ? "index" : path.slice(1)}.html`));
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, { headers: { "content-type": "text/html" } });
      },
    });
  });
  afterAll(async () => {
    await site.stop(true);
  });

  /** One browser launch, one capture of the stable pages at `concurrency`, into a fresh dir. */
  async function captureAt(concurrency: number) {
    const config = parseConfig({
      baseUrl: `http://127.0.0.1:${site.port}`,
      // Pages that render the same every time; `random`, `motion` and `ticker` change by design.
      routes: ["/", "/ignore", { path: "/masks", masks: MASKS }, "/early-timers"],
      variants: [
        { name: "desktop", viewport: { width: 800, height: 400 } },
        { name: "phone", viewport: { width: 375, height: 600 } },
      ],
    });
    const browser = await openCaptureSession(config, {
      env: { PIXELSLASH_IMAGE_VERSION: "test" },
      listFonts: async () => [],
    });
    try {
      const out = await tmpDir();
      const { manifest, captureWorkers } = await captureInto(browser, out, concurrency);
      return { out, manifest, captureWorkers, shots: await hashes(out) };
    } finally {
      await browser.close();
    }
  }

  test("one worker and six write the same shots, with the same bytes", async () => {
    const one = await captureAt(1);
    const six = await captureAt(6);
    const names = (m: typeof one.manifest) =>
      m.snapshots.map((e) => `${e.name}/${e.variant.name} ${e.file}`);
    expect(names(one.manifest)).toHaveLength(8);
    expect([one.captureWorkers, six.captureWorkers]).toEqual([1, 6]);
    expect(names(six.manifest)).toEqual(names(one.manifest));
    expect(Object.keys(one.shots)).toHaveLength(8);
    expect(six.shots).toEqual(one.shots);
  }, 60_000);
});
