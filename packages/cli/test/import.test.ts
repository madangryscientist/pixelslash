import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng, tmp } from "./support.ts";
import { gitRepo } from "./upload-support.ts";

afterAll(cleanup);

/** A dir of PNGs as a screenshot tool leaves them: loose, nested, with a stray file. */
async function pngDir(): Promise<string> {
  const dir = await tmp();
  await Bun.write(join(dir, "home.png"), solidPng(40, 40, [100, 100, 100, 255]));
  await Bun.write(join(dir, "billing/invoice.PNG"), solidPng(40, 60, [200, 200, 200, 255]));
  await Bun.write(join(dir, "notes.txt"), "not a shot");
  return dir;
}

/** An upload API that keeps each snapshot's `meta` part, as the server reads it. */
function metaApi() {
  const metas: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    const meta = init?.method === "PUT" && init.body instanceof FormData && init.body.get("meta");
    if (typeof meta === "string") metas.push(JSON.parse(meta));
    return Response.json({ id: "build-1", status: "passed" });
  };
  return { metas, fetch };
}

describe("pixelslash import", () => {
  test("writes a snapshot dir that upload sends and compare reads", async () => {
    const [from, out, cwd, api, cap] = [
      await pngDir(),
      join(await tmp(), "snaps"),
      await gitRepo(),
      metaApi(),
      capture(),
    ];
    const code = await run(["import", from, "--out", out, "--viewport", "800x600"], cap.io, {});
    expect(code).toBe(0);
    expect(cap.stdout).toBe(`pixelslash: 2 snapshots\nmanifest: ${join(out, "manifest.json")}\n`);

    const manifest = await Bun.file(join(out, "manifest.json")).json();
    expect(manifest.snapshots.map((s: { name: string; file: string }) => [s.name, s.file])).toEqual(
      [
        ["billing/invoice", "billing/invoice.PNG"],
        ["home", "home.png"],
      ],
    );
    expect(manifest.snapshots[1]).toMatchObject({
      variant: { browser: "chromium", viewport: { width: 800, height: 600 }, theme: "light" },
      fingerprint: { image: "external", browser: "external", fonts: "unknown" },
      diff: {},
      ignore: [],
    });
    expect(await Bun.file(join(out, "home.png")).exists()).toBe(true);
    expect(await Bun.file(join(out, "notes.txt")).exists()).toBe(false);

    const up = capture();
    const sent = await run(["upload", out, "--server", "https://ps.example"], up.io, {
      fetch: api.fetch,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_t" },
    });
    expect(sent).toBe(0);
    expect(up.stdout).toMatch(/uploaded 2 snapshots/);
    // Uploads run four at a time, so the order they arrive in is not the manifest's.
    const arrived = api.metas.map(
      (m) => `${String(m.name)} ${String(m.viewport)} ${String(m.theme)}`,
    );
    expect(arrived.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "billing/invoice 800x600 light",
      "home 800x600 light",
    ]);

    // The same shots again diff to nothing, and a changed one shows up: it is a snapshot dir.
    const again = join(await tmp(), "snaps");
    await Bun.write(join(from, "home.png"), solidPng(40, 40, [220, 220, 220, 255]));
    expect(await run(["import", from, "--out", again, "--viewport", "800x600"], cap.io, {})).toBe(
      0,
    );
    const cmp = capture();
    const report = join(await tmp(), "report");
    expect(await run(["compare", out, again, "--out", report], cmp.io, {})).toBe(0);
    expect(cmp.stdout).toMatch(/1 changed, 1 unchanged, 0 new, 0 removed/);
    expect(cmp.stdout).not.toMatch(/fingerprint:/);
  });

  test("--theme and --renderer set the identity and the fingerprint", async () => {
    const [from, out] = [await pngDir(), join(await tmp(), "snaps")];
    const argv = ["import", from, "--out", out, "--theme", "dark", "--renderer", "cypress 13"];
    expect(await run(argv, capture().io, {})).toBe(0);
    const { snapshots } = await Bun.file(join(out, "manifest.json")).json();
    expect(snapshots[0]).toMatchObject({
      variant: { viewport: { width: 1280, height: 720 }, theme: "dark" },
      fingerprint: { image: "external", browser: "cypress 13" },
    });
  });

  test("a bad flag, an empty dir, a fake PNG or an --out inside the dir is exit 2 and writes nothing", async () => {
    const [from, empty, fake, root] = [await pngDir(), await tmp(), await tmp(), await tmp()];
    await Bun.write(join(fake, "a.png"), "plain text");
    const out = join(root, "out");
    const tries: [string[], RegExp][] = [
      [["import"], /need a PNG_DIR/],
      [["import", from, "--viewport", "wide"], /--viewport must be WxH/],
      [["import", from, "--viewport", "0x10"], /--viewport must be WxH/],
      [["import", from, "--theme", "sepia"], /--theme must be light or dark/],
      [["import", from, "--bogus", "x"], /unexpected argument: --bogus/],
      [["import", join(from, "nope")], /is not a directory/],
      [["import", empty], /no \.png files/],
      [["import", fake, "--out", out], /manifest: a\.png is not a PNG/],
      [["import", from, "--out", join(from, "snaps")], /overlaps the PNG dir/],
    ];
    for (const [argv, message] of tries) {
      const cap = capture();
      expect(await run(argv, cap.io, {})).toBe(2);
      expect(cap.stderr).toMatch(message);
      expect(cap.stdout).toBe("");
    }
    expect(await Bun.file(join(from, "snaps/manifest.json")).exists()).toBe(false);
    expect(await Bun.file(join(out, "manifest.json")).exists()).toBe(false);
  });
});
