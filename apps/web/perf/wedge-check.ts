// A real wedge and a real recovery (PS-323, pointed at the web unit by PS-464). On demand: it is not
// in the gate, which runs deploy/ssh/watchdog.test.ts against a stub of this. It starts the web unit
// (deploy/ssh/serve.ts on the e2e build, as the CT runs it) in a user unit under the kind of limits
// that wedged on 2026-11-05 (a MemoryHigh just over what the app holds, no swap), uploads tall builds
// whose every pixel changed until GET / stops answering, then runs deploy/ssh/watchdog.sh against that
// unit until it answers again. No human, and no signal but the watchdog's restart. Exit 0 only on a
// recovery.
//
//   PIXELSLASH_E2E=1 CLOUDFLARE_ENV=e2e PIXELSLASH_E2E_STUB_PORT=9 bun run build
//   bun perf/wedge-check.ts --fresh 1     # needs `systemd-run --user` with the memory controller
//
// `--high` and `--max` (default 600M and 800M) are the wedging limits, `--size` (default 1280x15600,
// under the e2e build's pixel limit) the shots, `--port` (default 3465) where the unit listens.
// `--fresh 1` deletes apps/web/.wrangler/state, as web-burst.ts does.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shots } from "./corpus";
import {
  Client,
  type WebUnit,
  answers,
  hex,
  memoryEvents,
  memoryNow,
  project,
  startWebUnit,
  stopUnit,
} from "./web-unit";

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  flags.set((process.argv[i] ?? "").replace(/^--/, ""), process.argv[i + 1] ?? "");
const opt = (name: string, fallback: string) => flags.get(name) ?? fallback;

const PORT = Number(opt("port", "3465"));
const HIGH = opt("high", "600M");
const MAX = opt("max", "800M");
const SIZE = opt("size", "1280x15600");
const FRESH = opt("fresh", "0") === "1";
const WEB: WebUnit = {
  unit: "ps-wedge-check",
  port: PORT,
  server: `http://127.0.0.1:${PORT}`,
  limits: [`MemoryHigh=${HIGH}`, `MemoryMax=${MAX}`, "MemorySwapMax=0"],
};
const UNIT = WEB.unit;
const STRIKES = 4;
const INTERVAL_MS = 5000;
const STATE = mkdtempSync(join(tmpdir(), "ps-wedge-"));
const WATCHDOG = resolve(import.meta.dirname, "../deploy/ssh/watchdog.sh");

const run = (...args: string[]) => spawnSync(args[0] ?? "", args.slice(1), { encoding: "utf8" });
const show = (prop: string) =>
  run("systemctl", "--user", "show", UNIT, "-p", prop, "--value").stdout.trim();
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line: string) => process.stdout.write(`${stamp()} ${line}\n`);
const events = () =>
  Object.entries(memoryEvents(UNIT))
    .map(([k, v]) => `${k} ${v}`)
    .join(" ");
const alive = () => answers(WEB.server, 2000);

async function start() {
  const p = project("wedge");
  await startWebUnit(WEB, [p], { fresh: FRESH });
  say(`${UNIT} up on the wedging limits: High ${HIGH}, Max ${MAX}, swap 0`);
  return p;
}

async function comesUp(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await alive()) return true;
    await Bun.sleep(250);
  }
  return false;
}

/** A baseline, then branch builds whose every pixel changed, until GET / stops answering. */
async function feed(p: ReturnType<typeof project>) {
  const client = new Client(WEB.server, p);
  const baseline = shots(SIZE, 2, 300);
  const branch = shots(SIZE, 2, 900, 10);
  const sha = hex();
  const mainId = await client.open({ branch: "main", commitSha: sha });
  await client.putAll(mainId, baseline);
  await client.finalise(mainId, baseline.length);
  say(`${SIZE} baseline in; branch builds next`);
  // Not awaited: a wedged diff never returns. Each is abandoned when the unit is stopped.
  for (let i = 0; i < 3; i++) {
    void (async () => {
      const id = await client.open({
        branch: `work-${i}`,
        commitSha: hex(),
        mergeBaseSha: sha,
        ancestorShas: [sha],
      });
      await client.putAll(id, branch);
      const rounds = await client.finalise(id, branch.length);
      say(`build ${i}: ${rounds.at(-1)?.status}`);
    })().catch((e: unknown) => say(`build ${i}: no reply (${String(e).slice(0, 80)})`));
    await Bun.sleep(2500);
    if (!(await alive())) return;
  }
}

/** When the unit went silent, once that has lasted 20 s; 0 when it never did in 3 minutes. */
async function silentFor20s(): Promise<number> {
  let since = 0;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    since = (await alive()) ? 0 : since || Date.now();
    if (since && Date.now() - since > 20_000) return since;
    await Bun.sleep(1000);
  }
  return 0;
}

function reportWedge(silentSince: number) {
  const pid = show("MainPID");
  const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8");
  const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] ?? "?";
  say(
    `WEDGED: silent ${Math.round((Date.now() - silentSince) / 1000)} s; state ${state} at ${wchan}; ` +
      `ActiveState=${show("ActiveState")} Result=${show("Result")} NRestarts=${show("NRestarts")}; ` +
      `current ${memoryNow(UNIT).currentMB} MiB; ${events()}`,
  );
}

/** Passes of the real watchdog, as the timer runs them, until the unit is a new run of itself. */
async function runWatchdog(first: string) {
  for (let pass = 1; pass <= STRIKES + 2; pass++) {
    const child = spawn("bash", [WATCHDOG], {
      stdio: "inherit",
      env: {
        ...process.env,
        PIXELSLASH_WATCHDOG_STATE: STATE,
        PIXELSLASH_WATCHDOG_STRIKES: String(STRIKES),
        PIXELSLASH_WATCHDOG_WAIT_SECONDS: "3",
        PIXELSLASH_WATCHDOG_SYSTEMCTL: "systemctl --user",
        PIXELSLASH_WATCHDOG_TARGETS: `${UNIT}=${WEB.server}/`,
      },
    });
    await new Promise((done) => child.on("exit", done));
    if (show("InvocationID") !== first) return;
    await Bun.sleep(INTERVAL_MS);
  }
}

async function main(): Promise<number> {
  const p = await start();
  const first = show("InvocationID");
  await feed(p);

  // Wedged: silent for a long stretch, still active, nothing killed.
  const silentSince = await silentFor20s();
  if (!silentSince) {
    say("FAILED: the web unit never stopped answering, so this run proved nothing");
    return 2;
  }
  reportWedge(silentSince);
  if (show("ActiveState") !== "active" || show("InvocationID") !== first) {
    say("FAILED: the unit was restarted by something other than the watchdog");
    return 2;
  }

  const t0 = Date.now();
  await runWatchdog(first);
  if (show("InvocationID") === first) {
    say("FAILED: the watchdog did not restart the unit");
    return 1;
  }
  if (!(await comesUp())) {
    say("FAILED: restarted, and still not answering");
    return 1;
  }
  say(
    `RECOVERED by the watchdog: GET / answers ${Math.round((Date.now() - t0) / 1000)} s after its first pass`,
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} finally {
  stopUnit(UNIT);
  rmSync(STATE, { recursive: true, force: true });
}
process.exit(code);
