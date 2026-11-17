import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { STATE, WEB, run } from "./paths";

/**
 * The local-build suite's server (PS-15): the production build, served by `vite preview` over a fresh
 * local D1 and R2 in `.wrangler/local-build`, and nothing else. No GitHub stand-in, no sidecar and no
 * error sink are started, and every URL the build can call out to points at a port nothing listens
 * on, so the run reaches no host but this machine. It is integration: a local build on local data.
 *
 * This file is the config's `globalSetup`: the server is built and started once per run, and its URL
 * reaches the tests through `inject("localBuildUrl")` (`serverUrl()` in harness.ts).
 */

declare module "vitest" {
  export interface ProvidedContext {
    localBuildUrl: string;
  }
}

/** The built app's env: the e2e build, its state dir, and its outbound URLs on a closed port. */
function buildEnv(dead: number) {
  return {
    PIXELSLASH_E2E: "1",
    CLOUDFLARE_ENV: "e2e",
    PIXELSLASH_E2E_STATE: STATE,
    // The build's outbound URLs, all on a closed loopback port; "" turns the diff sidecar off.
    PIXELSLASH_E2E_STUB_PORT: String(dead),
    PIXELSLASH_E2E_SIDECAR: "",
    TMPDIR: join(WEB, STATE, "tmp"),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(child: ChildProcess, url: string) {
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || tries > 240) {
      child.kill("SIGTERM");
      throw new Error(`the local-build server did not come up; see ${join(STATE, "preview.log")}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Vitest `globalSetup`: build, migrate a fresh D1, serve; the returned function stops the server. */
export default async function setup(project: TestProject) {
  rmSync(join(WEB, STATE), { recursive: true, force: true });
  mkdirSync(join(WEB, STATE, "tmp"), { recursive: true });
  const [port, dead] = [await freePort(), await freePort()];
  const env = buildEnv(dead);
  run(["run", "build"], env);
  const migrate = ["d1", "migrations", "apply", "DB", "--local", "--env", "e2e"];
  run(["x", "wrangler", ...migrate, "--persist-to", STATE], env);
  const log = openSync(join(WEB, STATE, "preview.log"), "w");
  const child: ChildProcess = spawn(
    "bun",
    ["x", "vite", "preview", "--port", String(port), "--strictPort"],
    { cwd: WEB, env: { ...process.env, ...env }, stdio: ["ignore", log, log] },
  );
  const url = `http://localhost:${port}`;
  await waitUntilUp(child, url);
  project.provide("localBuildUrl", url);
  return async () => {
    child.kill("SIGTERM");
    await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r(null)));
  };
}
