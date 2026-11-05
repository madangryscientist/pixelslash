import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * watchdog.sh against a stub of the wedge (PS-323): a socket that accepts and never answers, as
 * port 3000 did on 2026-11-05, and a stub `systemctl` that reads `active` throughout, as systemd
 * did. A real unit over MemoryHigh cannot run in the gate; `perf/wedge-check.ts` is that run.
 * It uses `curl` for real.
 */
const SCRIPT = fileURLToPath(new URL("./watchdog.sh", import.meta.url));

let dir = "";
let silent: Server;
const held = new Set<Socket>();
let silentUrl = "";
let answering: ReturnType<typeof Bun.serve>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ps-watchdog-"));
  writeFileSync(join(dir, "state-of-unit"), "active");
  const stub = join(dir, "systemctl");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [[ $1 == show ]]; then cat "${dir}/state-of-unit"; echo
else echo "$*" >>"${dir}/log"; fi
`,
  );
  chmodSync(stub, 0o755);
  silent = createServer((socket) => held.add(socket));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  silentUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  answering = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("boom", { status: 500 }),
  });
});

afterEach(async () => {
  await answering.stop(true);
  for (const socket of held) socket.destroy();
  held.clear();
  await new Promise((resolve) => silent.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Not spawnSync: the answering server is in this process and needs its event loop. */
async function pass(url: string) {
  const run = Bun.spawn(["bash", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PIXELSLASH_WATCHDOG_STATE: join(dir, "state"),
      PIXELSLASH_WATCHDOG_SYSTEMCTL: join(dir, "systemctl"),
      PIXELSLASH_WATCHDOG_TARGETS: `unit=${url}`,
      PIXELSLASH_WATCHDOG_STRIKES: "3",
      PIXELSLASH_WATCHDOG_WAIT_SECONDS: "0.2",
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(stderr).toBe("");
  expect(status).toBe(0);
  return stdout;
}

const restarts = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "");

describe("watchdog.sh", () => {
  test("an active unit that stops answering is restarted, with no human, at the last strike", async () => {
    expect(await pass(silentUrl)).toContain("1 of 3");
    expect(await pass(silentUrl)).toContain("2 of 3");
    expect(restarts()).toBe("");
    expect(await pass(silentUrl)).toContain("active and silent for 3 checks: restarting");
    expect(restarts()).toBe("restart unit\n");
    // The count starts again, so a unit that stays silent is restarted again only after as long.
    expect(await pass(silentUrl)).toContain("1 of 3");
    expect(restarts()).toBe("restart unit\n");
  });

  test("an answer, a 500 too, clears the count and restarts nothing", async () => {
    const alive = answering.url.toString();
    await pass(silentUrl);
    await pass(silentUrl);
    expect(await pass(alive)).toBe("");
    expect(await pass(silentUrl)).toContain("1 of 3");
    expect(restarts()).toBe("");
  });

  test("a unit that is not active is left to Restart=", async () => {
    await pass(silentUrl);
    await pass(silentUrl);
    writeFileSync(join(dir, "state-of-unit"), "activating");
    expect(await pass(silentUrl)).toBe("");
    writeFileSync(join(dir, "state-of-unit"), "active");
    expect(await pass(silentUrl)).toContain("1 of 3");
    expect(restarts()).toBe("");
  });
});
