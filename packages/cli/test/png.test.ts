import { afterAll, describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnProc } from "@hackcove/pixelslash-engine";
import { run } from "../src/run.ts";
import { DS, capture, cleanup, fakeProc, identicalSpawn, newMissSpawn, tmp } from "./support.ts";

afterAll(cleanup);

const mlxAndOllama = (bin: string) =>
  bin === "mlx_vlm.generate" || bin === "ollama" ? `/bin/${bin}` : null;
const ollamaOnly = (bin: string) => (bin === "ollama" ? "/bin/ollama" : null);

describe("png shots", () => {
  test("--live-png --local-png skip Playwright and judge like URLs", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn: newMissSpawn() },
    );
    expect(code).toBe(1);
    expect(cap.stdout).toMatch(/1 new/);
    expect(cap.stdout).toContain("card");
    expect(existsSync(join(out, "live.png"))).toBe(true);
    expect(existsSync(join(out, "local.png"))).toBe(true);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("<figcaption>Main</figcaption>");
    expect(html).toContain("<figcaption>Branch</figcaption>");
    expect(html).toMatch(/new[\s\S]*card/i);
    const alreadyHtml = html.match(/<section class="already">[\s\S]*?<\/section>/)?.[0] ?? "";
    const newHtml = html.match(/<section class="new">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(alreadyHtml).toContain("<h3>button</h3>");
    expect(newHtml).toContain("<h3>card</h3>");
  });

  test("missing judge writes HTML, prints skip, exit 0, no fake violations", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { which: () => null },
    );
    expect(code).toBe(0);
    expect(cap.stdout).toMatch(/skip: no judge/);
    expect(cap.stdout).not.toMatch(/new on branch/);
    const html = await Bun.file(join(out, "report.html")).text();
    expect(html).toContain("<figcaption>Main</figcaption>");
    expect(html).toContain("<figcaption>Branch</figcaption>");
    expect(html).toContain("live.png");
    expect(html).toContain("local.png");
    expect(html).toContain("No violations on Main.");
    expect(html).toContain("No new violations");
    expect(html).not.toContain("<h3>");
    expect(existsSync(join(out, "live.png"))).toBe(true);
    expect(existsSync(join(out, "ds/button.png"))).toBe(true);
  });

  test("mlx preferred when ollama is also present", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc("OK");
    };
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn, which: mlxAndOllama },
    );
    expect(code).toBe(0);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]![0]).toBe("mlx_vlm.generate");
    expect(cmds.some((c) => c[0] === "ollama")).toBe(false);
  });

  test("ollama when mlx missing: argv is ollama run qwen2.5vl", async () => {
    const dir = await tmp();
    const out = join(dir, "out");
    const cap = capture();
    const cmds: string[][] = [];
    const spawn: SpawnProc = (cmd) => {
      cmds.push(cmd);
      return fakeProc("OK");
    };
    const code = await run(
      [
        "--live-png",
        join(DS, "button.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
        "--out",
        out,
      ],
      cap.io,
      { spawn, which: ollamaOnly },
    );
    expect(code).toBe(0);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]!.slice(0, 3)).toEqual(["ollama", "run", "qwen2.5vl"]);
    expect(cmds[0]![3]).toBe(join(out, "live.png"));
    expect(cmds[0]![4]).toMatch(/\.png$/);
    expect(cmds.every((c) => c[0] === "ollama")).toBe(true);
  });

  test("missing live-png file exit 2", async () => {
    const cap = capture();
    const code = await run(
      [
        "--live-png",
        join(tmpdir(), "visual-compare-no-live.png"),
        "--local-png",
        join(DS, "card.png"),
        "--ds",
        DS,
      ],
      cap.io,
      { spawn: identicalSpawn() },
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/live-png not found/);
  });
});
