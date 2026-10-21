import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureError } from "../src/errors.ts";
import { startApp } from "../src/start.ts";

const dirs: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop(true);
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function marker(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ps-start-"));
  dirs.push(dir);
  return join(dir, "spawned");
}

describe("startApp", () => {
  test("refuses when the ready URL already answers, and never runs the command", async () => {
    const spawned = await marker();
    const other = Bun.serve({ port: 0, fetch: () => new Response("someone else's") });
    servers.push(other);
    const readyUrl = `http://127.0.0.1:${other.port}/`;
    const started = startApp({ command: `touch ${spawned}`, readyUrl, timeoutMs: 5_000 });
    await expect(started).rejects.toBeInstanceOf(CaptureError);
    await expect(started).rejects.toThrow(`something already answers on ${readyUrl}; stop it`);
    expect(await Bun.file(spawned).exists()).toBe(false);
  });

  test("a start command that exited is an error even when the URL answers", async () => {
    const spawned = await marker();
    // Silent until the command has run, then slow to answer: by the time the
    // probe comes back the command is long gone, as a taken port leaves it.
    const other = Bun.serve({
      port: 0,
      fetch: async () => {
        if (!(await Bun.file(spawned).exists())) return new Response("down", { status: 503 });
        await Bun.sleep(300);
        return new Response("the other worktree's server");
      },
    });
    servers.push(other);
    const started = startApp({
      command: `touch ${spawned}; exit 1`,
      readyUrl: `http://127.0.0.1:${other.port}/`,
      timeoutMs: 5_000,
    });
    await expect(started).rejects.toBeInstanceOf(CaptureError);
    await expect(started).rejects.toThrow(/start command exited \(code 1\)/);
  });
});
