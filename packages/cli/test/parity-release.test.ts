import { afterAll, describe, expect, test } from "vitest";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import { SERVER } from "./remote-support.ts";
import {
  android,
  deps,
  manifestDir,
  parityApi,
  releaseApi,
  staleTwin,
  web,
} from "./parity-support.ts";

afterAll(cleanup);

const release = async (api: ReturnType<typeof parityApi>, extra: string[] = [], cwd?: string) => {
  const cap = capture();
  const code = await run(
    ["parity", "--release", "android", "--project", "web", "--server", SERVER, ...extra],
    cap.io,
    await deps(api, cwd),
  );
  return { code, out: cap.stdout, err: cap.stderr };
};

describe("pixelslash parity --release (PS-297)", () => {
  test("a stale twin exits 8: its sentence, then the summary line", async () => {
    const api = releaseApi([web(), android()], [staleTwin()]);
    const r = await release(api);
    expect(r.code).toBe(8);
    expect(r.out).toBe(
      `${staleTwin().sentence}\nrelease android: 1 stale, 0 drifting, 1 pairs checked\n`,
    );
    const asked = api.seen.find((s) => s.url.pathname === "/api/v1/projects/p1/stale");
    expect(asked?.url.searchParams.get("platform")).toBe("android");
  });

  test("a drifting baseline pair exits 8, with the PS-296 line", async () => {
    const r = await release(releaseApi([web({ gap: 8 }), android({ gap: 6 })]));
    expect(r.code).toBe(8);
    expect(r.out).toBe(
      "Button/md-primary dark: button gap 8 web vs 6 android\n" +
        "release android: 0 stale, 1 drifting, 1 pairs checked\n",
    );
  });

  test("stale and drift together are counted, stale sentences first", async () => {
    const r = await release(releaseApi([web({ gap: 8 }), android({ gap: 6 })], [staleTwin()]));
    expect(r.code).toBe(8);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(staleTwin().sentence);
    expect(lines.at(-2)).toBe("release android: 1 stale, 1 drifting, 1 pairs checked");
  });

  test("nothing stale and no drift exits 0", async () => {
    const r = await release(releaseApi([web(), android()]));
    expect(r.code).toBe(0);
    expect(r.out).toBe("release android: 0 stale, 0 drifting, 1 pairs checked\n");
  });

  test("a pair without a metrics file is not checked, never drift", async () => {
    const r = await release(releaseApi([web(), { ...android(), metrics: null }]));
    expect(r.code).toBe(0);
    expect(r.out).toBe("release android: 0 stale, 0 drifting, 0 pairs checked\n");
  });

  test("the same --manifest allowances apply to the baselines", async () => {
    const cwd = await manifestDir({
      version: 1,
      differences: { "Button/md-primary": { button: { web: { gap: 8 }, android: { gap: 6 } } } },
    });
    const r = await release(releaseApi([web({ gap: 8 }), android({ gap: 6 })]), [], cwd);
    expect(r.code).toBe(0);
    expect(r.out).toBe("release android: 0 stale, 0 drifting, 1 pairs checked\n");
  });

  test("--json describes itself: verdict, counts, the stale twins and every pair", async () => {
    const r = await release(releaseApi([web({ gap: 8 }), android({ gap: 6 })], [staleTwin()]), [
      "--json",
    ]);
    expect(r.code).toBe(8);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({
      release: "android",
      project: { id: "p1", name: "web" },
      manifest: null,
      ok: false,
      exit_code: 8,
      stale: 1,
      drifting: 1,
      pairs_checked: 1,
      not_measured: 0,
      stale_declarations: [],
    });
    expect(report.stale_twins).toEqual([staleTwin()]);
    expect(report.findings).toHaveLength(2);
    expect(report.findings[0]).toMatchObject({
      kind: "stale",
      name: "Button/md-primary",
      theme: "dark",
      platform: "android",
      cause: staleTwin().cause,
    });
    expect(report.findings[1]).toMatchObject({
      kind: "drift",
      name: "Button/md-primary",
      theme: "dark",
      platform: "android",
    });
    expect(report.findings[1].mismatches.length).toBeGreaterThan(0);
    expect(report.results[0]).toMatchObject({ status: "drift", name: "Button/md-primary" });
    const clean = JSON.parse((await release(releaseApi([web(), android()]), ["--json"])).out);
    expect(clean).toMatchObject({
      ok: true,
      exit_code: 0,
      stale: 0,
      drifting: 0,
      stale_twins: [],
      findings: [],
    });
  });

  test("--release with --build is a usage error, before any request", async () => {
    const api = releaseApi([web(), android()]);
    const r = await release(api, ["--build", "b2"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--release and --build cannot be combined");
    expect(api.seen).toHaveLength(0);
  });

  test("--release takes android or ios; anything else is a usage error", async () => {
    const cap = capture();
    const d = await deps(releaseApi([]));
    expect(await run(["parity", "--release", "web", "--server", SERVER], cap.io, d)).toBe(2);
    expect(cap.stderr).toContain('--release must be android or ios (got "web")');
  });

  test("a project the token does not see exits 2; a server that fails exits 3", async () => {
    const cap = capture();
    const d = await deps(releaseApi([]));
    expect(
      await run(
        ["parity", "--release", "android", "--project", "nope", "--server", SERVER],
        cap.io,
        d,
      ),
    ).toBe(2);
    const gone = releaseApi([]);
    delete gone.replies["/api/v1/projects/p1/stale"];
    expect((await release(gone)).code).toBe(3);
  });
});
