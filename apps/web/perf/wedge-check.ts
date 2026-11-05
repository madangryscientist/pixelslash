// A real wedge and a real recovery (PS-323). On demand: it is not in the gate, which runs
// deploy/ssh/watchdog.test.ts against a stub of this. It starts the diff sidecar in a user unit under
// the limits that wedged on 2026-11-05 (MemoryHigh 450M, MemoryMax 600M, no swap), feeds it 1280x16800
// diffs until it stops answering, then runs deploy/ssh/watchdog.sh against that unit until the unit
// answers again. No human, and no signal but the watchdog's restart. Exit 0 only on a recovery.
//
//   bun perf/wedge-check.ts              # needs `systemd-run --user` with the memory controller
//
// It uses the sidecar's own port (4181) unless PIXELSLASH_DIFF_SIDECAR_PORT says otherwise.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SIDECAR_PATH, encodeRequest } from "../src/diff/sidecar-wire";
import { png } from "../e2e/png";

const UNIT = "ps-wedge-check";
const PORT = process.env["PIXELSLASH_DIFF_SIDECAR_PORT"] ?? "4181";
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const WIDTH = 1280;
const HEIGHT = 16800;
const STRIKES = 4;
const INTERVAL_MS = 5000;
const STATE = mkdtempSync(join(tmpdir(), "ps-wedge-"));
const SIDECAR = resolve(import.meta.dirname, "../deploy/ssh/diff-sidecar.ts");
const WATCHDOG = resolve(import.meta.dirname, "../deploy/ssh/watchdog.sh");

const run = (...args: string[]) => spawnSync(args[0] ?? "", args.slice(1), { encoding: "utf8" });
const show = (prop: string) =>
  run("systemctl", "--user", "show", UNIT, "-p", prop, "--value").stdout.trim();
const cgroup = () => `/sys/fs/cgroup${show("ControlGroup")}`;
const memory = (file: string) => readFileSync(join(cgroup(), file), "utf8");
const mib = (bytes: number) => Math.round(bytes / 1048576);
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line: string) => process.stdout.write(`${stamp()} ${line}\n`);
const events = () => memory("memory.events").trim().replaceAll("\n", " ");

async function answers(ms = 2000): Promise<boolean> {
  try {
    await (await fetch(HEALTH, { signal: AbortSignal.timeout(ms) })).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** The e2e fixture's text-like rows, which do not compress away: the same pair as a real tall page. */
const tall = (y: number) =>
  Buffer.from(png(WIDTH, HEIGHT, [{ x: 40, y, w: 60, h: 400, rgb: [220, 30, 30] }], 0));

function stop() {
  run("systemctl", "--user", "stop", UNIT);
  run("systemctl", "--user", "reset-failed", UNIT);
}

async function start() {
  stop();
  const limits = ["MemoryHigh=450M", "MemoryMax=600M", "MemorySwapMax=0"];
  const restart = ["Restart=on-failure", "RestartSec=2"];
  const started = run(
    "systemd-run",
    "--user",
    "--quiet",
    `--unit=${UNIT}`,
    ...[...limits, ...restart].flatMap((property) => ["-p", property]),
    "-E",
    `PIXELSLASH_DIFF_SIDECAR_PORT=${PORT}`,
    process.execPath,
    SIDECAR,
  );
  if (started.status !== 0) throw new Error(`systemd-run: ${started.stderr}`);
  if (!(await comesUp())) throw new Error("the sidecar did not come up");
  say(`${UNIT} up on the old limits: High 450M, Max 600M, swap 0`);
}

async function comesUp(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await answers()) return true;
    await Bun.sleep(250);
  }
  return false;
}

async function feed() {
  const body = encodeRequest({ main: tall(300), branch: tall(900), options: {}, ignore: {} });
  say(`${WIDTH}x${HEIGHT} pair, ${mib(body.length)} MiB on the wire`);
  // Not awaited: a wedged diff never returns. Each is abandoned when the unit is stopped.
  for (let i = 0; i < 3; i++) {
    void fetch(`http://127.0.0.1:${PORT}${SIDECAR_PATH}`, { method: "POST", body }).then(
      async (res) => {
        await res.arrayBuffer();
        say(`diff ${i}: HTTP ${res.status}`);
      },
      () => say(`diff ${i}: no reply`),
    );
    await Bun.sleep(2500);
    if (!(await answers())) return;
  }
}

/** When the sidecar went silent, once that has lasted 20 s; 0 when it never did in 2 minutes. */
async function silentFor20s(): Promise<number> {
  let since = 0;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    since = (await answers()) ? 0 : since || Date.now();
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
      `current ${mib(Number(memory("memory.current")))} MiB; ${events()}`,
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
        PIXELSLASH_WATCHDOG_TARGETS: `${UNIT}=${HEALTH}`,
      },
    });
    await new Promise((done) => child.on("exit", done));
    if (show("InvocationID") !== first) return;
    await Bun.sleep(INTERVAL_MS);
  }
}

async function main(): Promise<number> {
  await start();
  const first = show("InvocationID");
  await feed();

  // Wedged: silent for a long stretch, still active, nothing killed.
  const silentSince = await silentFor20s();
  if (!silentSince) {
    say("FAILED: the sidecar never stopped answering, so this run proved nothing");
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
    `RECOVERED by the watchdog: /health answers ${Math.round((Date.now() - t0) / 1000)} s after its first pass`,
  );
  return 0;
}

let code = 1;
try {
  code = await main();
} finally {
  stop();
  rmSync(STATE, { recursive: true, force: true });
}
process.exit(code);
