import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup, solidPng } from "./support.ts";
import { gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

const SERVER = "https://ps.example";

/** A server project whose baseline for every shot is a different colour from the shot. */
function changedBaselines() {
  const puts: FormData[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/v1/builds") return Response.json({ id: "b1", diffLocation: "server" });
    if (path.endsWith("/baselines")) {
      const keys: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}").keys;
      if (!Array.isArray(keys)) throw new Error("no keys sent");
      const baseline = {
        id: "s0",
        image_url: "/images/s0.png",
        fingerprint: { image: "version:t", browser: "chromium 1", fonts: "sha256:f" },
        ignore: [],
      };
      return Response.json({
        api_version: 1,
        diff_location: "server",
        baselines: keys.map((key) => ({ key, baseline, carry: null, accepted: null })),
      });
    }
    if (path.startsWith("/images/")) return new Response(solidPng(4, 4, [200, 0, 0, 255]));
    if (init?.body instanceof FormData) puts.push(init.body);
    return Response.json({ id: "build-1", status: "passed" });
  };
  return { fetch, puts };
}

describe("upload DIR re-captures through the config (ob 1737)", () => {
  test("a shot from another image is not captured again, and no browser is opened", async () => {
    const [cwd, dir, api, cap] = [
      await gitRepo(),
      await snapshotDir(),
      changedBaselines(),
      capture(),
    ];
    await Bun.write(
      join(cwd, "pixelslash.config.json"),
      JSON.stringify({ baseUrl: "http://127.0.0.1:1", routes: ["/"] }),
    );
    const code = await run(["upload", dir, "--server", SERVER], cap.io, {
      fetch: api.fetch,
      cwd,
      env: { PIXELSLASH_TOKEN: "psci_t" },
    });
    expect(code).toBe(0);
    expect(cap.stderr).toMatch(
      /home .*: not captured again \(it was captured with a different image/,
    );
    // Opening a capture session outside the pinned image warns about it; it never got that far.
    expect(cap.stderr).not.toMatch(/capturing outside the pinned PixelSlash image/);
    expect(api.puts).toHaveLength(1);
    const sent = api.puts[0]?.get("meta");
    const meta: unknown = JSON.parse(typeof sent === "string" ? sent : "{}");
    expect(meta).toMatchObject({ flaky: "review" });
    expect(meta).not.toHaveProperty("flake");
  });
});
