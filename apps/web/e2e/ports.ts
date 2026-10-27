/**
 * Where the e2e web server, the GitHub stand-in, the diff sidecar and the Sentry ingest stand-in listen. The first process to
 * import this (Playwright loading `playwright.config.ts`) picks four free ports and exports them as env vars;
 * the workers inherit them, so the specs, the config and the servers agree. Two runs, from two
 * worktrees, therefore never share a port. Set the vars to pin them.
 */
import { createServer } from "node:net";

const SERVER_PORT_VAR = "PIXELSLASH_E2E_PORT";
const STUB_PORT_VAR = "PIXELSLASH_E2E_STUB_PORT";
const SIDECAR_PORT_VAR = "PIXELSLASH_DIFF_SIDECAR_PORT";
const SENTRY_PORT_VAR = "PIXELSLASH_E2E_SENTRY_PORT";

/** Ask the OS for `count` distinct free ports: all probes stay open until every port is read. */
async function freePorts(count: number): Promise<number[]> {
  const probes = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const probe = createServer();
          probe.once("error", reject);
          probe.listen(0, () => resolve(probe));
        }),
    ),
  );
  const ports = probes.map((probe) => {
    const address = probe.address();
    return typeof address === "object" && address ? address.port : 0;
  });
  await Promise.all(probes.map((probe) => new Promise((done) => probe.close(done))));
  return ports;
}

const [serverFree = 0, stubFree = 0, sidecarFree = 0, sentryFree = 0] = await freePorts(4);

function pick(name: string, free: number): number {
  const pinned = process.env[name];
  if (pinned) return Number(pinned);
  process.env[name] = String(free);
  return free;
}

export const SERVER_PORT = pick(SERVER_PORT_VAR, serverFree);
export const STUB_PORT = pick(STUB_PORT_VAR, stubFree);
/** The diff sidecar's (PS-203); `deploy/ssh/diff-sidecar.ts` reads the same var. */
export const SIDECAR_PORT = pick(SIDECAR_PORT_VAR, sidecarFree);
/** The Sentry ingest stand-in's (PS-227): `e2e/sentry-ingest.ts`, which the Worker and the browser report to. */
export const SENTRY_PORT = pick(SENTRY_PORT_VAR, sentryFree);

export const SERVER = `http://localhost:${SERVER_PORT}`;
export const STUB = `http://localhost:${STUB_PORT}`;
export const SIDECAR = `http://127.0.0.1:${SIDECAR_PORT}`;
export const SENTRY_INGEST = `http://localhost:${SENTRY_PORT}`;
