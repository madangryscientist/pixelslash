/**
 * Where the e2e web server and the GitHub stand-in listen. The first process to import this
 * (Playwright loading `playwright.config.ts`) picks two free ports and exports them as env vars;
 * the workers inherit them, so the specs, the config and both servers agree. Two runs, from two
 * worktrees, therefore never share a port. Set the vars to pin them.
 */
import { createServer } from "node:net";

const SERVER_PORT_VAR = "PIXELSLASH_E2E_PORT";
const STUB_PORT_VAR = "PIXELSLASH_E2E_STUB_PORT";

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

const [serverFree = 0, stubFree = 0] = await freePorts(2);

function pick(name: string, free: number): number {
  const pinned = process.env[name];
  if (pinned) return Number(pinned);
  process.env[name] = String(free);
  return free;
}

export const SERVER_PORT = pick(SERVER_PORT_VAR, serverFree);
export const STUB_PORT = pick(STUB_PORT_VAR, stubFree);

export const SERVER = `http://localhost:${SERVER_PORT}`;
export const STUB = `http://localhost:${STUB_PORT}`;
