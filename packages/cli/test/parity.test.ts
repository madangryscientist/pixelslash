import { afterAll, describe, expect, test } from "vitest";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import { SERVER } from "./remote-support.ts";
import {
  android,
  button,
  deps,
  manifestDir,
  metricsFile,
  parityApi,
  web,
} from "./parity-support.ts";

afterAll(cleanup);

const parity = async (api: ReturnType<typeof parityApi>, extra: string[] = [], cwd?: string) => {
  const cap = capture();
  const code = await run(
    ["parity", "--build", "b2", "--server", SERVER, ...extra],
    cap.io,
    await deps(api, cwd),
  );
  return { code, out: cap.stdout, err: cap.stderr };
};

const other = (platform: "web" | "android", id: string, gap: number) => ({
  id,
  platform,
  name: "Card",
  metrics: metricsFile({ button: button({ gap }) }),
});

const colored = (hex: string) => ({ color: { bg: hex } });
const colorApi = () => parityApi([web(colored("#ff0000")), android(colored("#f50a05"))]);

describe("pixelslash parity", () => {
  test("the drill: a button gap of 8 vs 6 exits 8 and names snapshot, part, field and values", async () => {
    const r = await parity(parityApi([web({ gap: 8 }), android({ gap: 6 })]));
    expect(r.code).toBe(8);
    expect(r.out).toBe(
      "Button/md-primary dark: button gap 8 web vs 6 android\n" +
        "parity: 1 pairs, 1 with drift, 0 not measured\n",
    );
  });

  test("a clean build exits 0", async () => {
    const r = await parity(parityApi([web(), android()]));
    expect(r.code).toBe(0);
    expect(r.out).toBe("parity: 1 pairs, 0 with drift, 0 not measured\n");
  });

  test("a build with no twins prints `parity: no twins` and exits 0", async () => {
    const r = await parity(parityApi([]));
    expect(r.code).toBe(0);
    expect(r.out).toBe("parity: no twins\n");
  });

  test("a pair without a metrics file is not measured and exits 0", async () => {
    const api = parityApi([web(), { ...android(), metrics: null }]);
    const r = await parity(api);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "not measured: Button/md-primary dark (android has no metrics file)\n" +
        "parity: 1 pairs, 0 with drift, 1 not measured\n",
    );
    // Nothing was fetched for the side that has a file either: the pair is not read.
    expect(api.seen.some((s) => s.url.pathname.startsWith("/api/v1/snapshots/"))).toBe(false);
  });

  test("an unmeasured pair does not hide drift in another", async () => {
    const api = parityApi(
      [web({ gap: 8 }), android({ gap: 6 })],
      [[other("web", "w2", 4), { ...other("android", "a2", 4), metrics: null }]],
    );
    const r = await parity(api);
    expect(r.code).toBe(8);
    expect(r.out).toContain("parity: 2 pairs, 1 with drift, 1 not measured\n");
  });

  test("every pair of several shots per side is compared", async () => {
    const api = parityApi([web({ gap: 8 }), { ...web({ gap: 8 }), id: "w2" }, android({ gap: 6 })]);
    const r = await parity(api);
    expect(r.code).toBe(8);
    expect(r.out).toContain("parity: 2 pairs, 2 with drift, 0 not measured\n");
    // The two lines would read the same, so each says which shots.
    expect(r.out).toContain(
      "Button/md-primary dark (web chromium 390x844 vs android pixel-8 1080x2400): ",
    );
  });

  test("a manifest in the cwd declares a difference; a stale one is reported and does not fail", async () => {
    const cwd = await manifestDir({
      version: 1,
      differences: {
        "Button/md-primary": { button: { web: { gap: 8 }, android: { gap: 6 } } },
        "Button/gone": { button: { web: { gap: 1 }, android: { gap: 2 } } },
      },
    });
    const r = await parity(parityApi([web({ gap: 8 }), android({ gap: 6 })]), [], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toBe("parity: 1 pairs, 0 with drift, 0 not measured\n");
    const agreed = await parity(parityApi([web({ gap: 6 }), android({ gap: 6 })]), [], cwd);
    expect(agreed.code).toBe(0);
    expect(agreed.out).toContain(
      "stale declaration: Button/md-primary button gap: both sides agree now (6)\n",
    );
  });

  test("--manifest names a file, and a missing one is a usage error", async () => {
    const cwd = await manifestDir(
      {
        version: 1,
        colors: [{ web: "#ff0000", native: "#f50a05" }],
      },
      "colours.json",
    );
    expect((await parity(colorApi(), [], cwd)).code).toBe(8);
    expect((await parity(colorApi(), ["--manifest", "colours.json"], cwd)).code).toBe(0);
    const missing = await parity(colorApi(), ["--manifest", "nope.json"], cwd);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--manifest nope.json: no such file");
  });

  test("a malformed manifest exits 2 naming the file and the field, before any request", async () => {
    const cwd = await manifestDir({
      version: 1,
      colors: [{ web: "red", native: "#000000" }],
    });
    const api = parityApi([web(), android()]);
    const r = await parity(api, [], cwd);
    expect(r.code).toBe(2);
    expect(r.err).toContain("pixelslash.parity.json: manifest.colors[0].web must be lowercase");
    expect(api.seen).toHaveLength(0);
    const broken = await parity(api, [], await manifestDir("{nope"));
    expect(broken.code).toBe(2);
    expect(broken.err).toContain("pixelslash.parity.json: not valid JSON");
  });

  test("--json is the full result", async () => {
    const r = await parity(parityApi([web({ gap: 8 }), android({ gap: 6 })]), ["--json"]);
    expect(r.code).toBe(8);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({
      build: "b2",
      manifest: null,
      pairs: 1,
      drift: 1,
      not_measured: 0,
      stale_declarations: [],
    });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      name: "Button/md-primary",
      theme: "dark",
      status: "drift",
      tolerance: 1,
      line: "Button/md-primary dark: button gap 8 web vs 6 android",
      sides: [
        { platform: "web", snapshot_id: "w1", scale: 1, scale_source: "default" },
        { platform: "android", snapshot_id: "a1", scale: 3, scale_source: "recorded" },
      ],
    });
  });

  test("a build the server does not have exits 3; metrics it cannot parse exit 3", async () => {
    const gone = capture();
    const api = parityApi([web(), android()]);
    expect(
      await run(["parity", "--build", "nope", "--server", SERVER], gone.io, await deps(api)),
    ).toBe(3);
    const bad = parityApi([web(), { ...android(), metrics: { version: "1.0" } }]);
    const r = await parity(bad);
    expect(r.code).toBe(3);
    expect(r.err).toContain("metrics of snapshot a1");
  });

  test("usage errors exit 2: no --build, an unknown flag", async () => {
    const cap = capture();
    const d = await deps(parityApi([]));
    expect(await run(["parity", "--server", SERVER], cap.io, d)).toBe(2);
    expect(cap.stderr).toContain("need --build ID");
    expect(await run(["parity", "--build", "b2", "--nope", "x"], capture().io, d)).toBe(2);
  });
});
