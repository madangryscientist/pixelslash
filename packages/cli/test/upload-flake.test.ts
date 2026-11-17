import { afterAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { run } from "../src/run.ts";
import { capture, cleanup } from "./support.ts";
import { changedBaselines, gitRepo, snapshotDir } from "./upload-support.ts";

afterAll(cleanup);

const SERVER = "https://ps.example";

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
