/**
 * `pixelslash-bench-reserve on|off|renew|status` (ob 1947): the one root step of `bench:perf --env dedicated`.
 * It takes whole cores out of the host's CPU sets, puts the caller's runner in a scope that owns
 * them with its memory guaranteed, turns boost off and keeps the performance governor, and puts
 * all of it back on `off`. Everything is `--runtime`, so a reboot undoes it too.
 *
 * A reservation squeezes every other process onto the CPUs left, so it is bounded twice: the host
 * keeps at least MIN_HOST_CPUS, and `on` arms a systemd timer that runs `off` after LIFETIME_S
 * unless `renew` moves it. systemd enforces the bound, not the caller, because the callers that
 * forget are the ones that would not renew.
 *
 * Root runs this through one sudoers line, so it takes no free-form input: three flags, each
 * validated here, and every command it runs is a fixed argv (no shell). All effects go through
 * `Host`, which a test replaces; the real one is ./host.ts. `off` is a full restore from the
 * journal `on` wrote before it changed anything, so it is safe to run twice, after a crash, or
 * when `on` never finished.
 */
import { HelperError } from "./error.ts";
import { formatCpus, parseCpus, without } from "./cpulist.ts";
import { armLapse, LapseError, LIFETIME_S } from "./lapse.ts";
import { SCOPE, systemctl, type Host } from "./machine.ts";
import { releaseAfter, restore, stopLapse } from "./restore.ts";
import {
  BOOST,
  cpuFile,
  HOST_UNITS,
  JOURNAL_VERSION,
  readJournal,
  show,
  snapshot,
  STATE_DIR,
  STATE_FILE,
  type Journal,
} from "./journal.ts";

/** Bumped when the helper's behaviour changes; the runner refuses a helper that does not match. */
export const HELPER_VERSION = 3;
/** CPUs the host must keep: two whole cores, so desktop work and captures are never squeezed onto one. */
export const MIN_HOST_CPUS = 4;
/** Written for as long as an `on` or a `renew` runs, so an `off` cannot restore under it. */
export const ON_FILE = `${STATE_DIR}/on.pid`;
export const DEFAULT_CPUS = "4,5,10,11";
export const DEFAULT_MEM = "4G";

const ONLINE = "/sys/devices/system/cpu/online";

export type Request =
  | { cmd: "on"; cpus: number[]; mem: string; pid: number }
  | { cmd: "off" }
  | { cmd: "renew" }
  | { cmd: "status" };

const FLAGS = ["--cpus", "--mem", "--pid"];

export function parseRequest(argv: string[]): Request {
  const [cmd, ...rest] = argv;
  if (cmd === "off" || cmd === "renew" || cmd === "status") {
    if (rest.length > 0) throw new HelperError(`${cmd} takes no arguments`);
    return { cmd };
  }
  if (cmd !== "on") throw new HelperError("usage: pixelslash-bench-reserve on|off|renew|status");
  const given = onFlags(rest);
  return {
    cmd,
    cpus: parseCpus(given.get("--cpus") ?? DEFAULT_CPUS),
    mem: parseMem(given.get("--mem") ?? DEFAULT_MEM),
    pid: parsePid(given.get("--pid")),
  };
}

function onFlags(rest: string[]): Map<string, string> {
  const given = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? "";
    const value = rest[i + 1];
    if (!FLAGS.includes(flag) || value === undefined || given.has(flag))
      throw new HelperError(`on takes ${FLAGS.join(" ")}, each once, each with a value`);
    given.set(flag, value);
  }
  return given;
}

function parseMem(raw: string): string {
  if (!/^[1-9][0-9]{0,2}[MG]$/.test(raw)) throw new HelperError(`--mem must look like 4G or 512M`);
  return raw;
}

/** A reservation is pinned memory: the host must keep at least half of what it has. */
function checkMem(host: Host, mem: string): void {
  const total = Number(/^MemTotal:\s+(\d+) kB/m.exec(host.read("/proc/meminfo") ?? "")?.[1]);
  const wanted = Number.parseInt(mem, 10) * (mem.endsWith("G") ? 1024 * 1024 : 1024);
  if (!(total > 0) || wanted > total / 2)
    throw new HelperError("--mem must be at most half of the machine's memory");
}

function parsePid(raw: string | undefined): number {
  const pid = Number(raw);
  if (raw === undefined || !/^[0-9]+$/.test(raw) || pid < 2 || pid > 4_194_304)
    throw new HelperError("--pid must be the runner's process id");
  return pid;
}

/** The online CPUs the request must stay inside, and the ones left to the host. */
function checkAgainstHost(host: Host, req: Extract<Request, { cmd: "on" }>): number[] {
  const online = parseCpus(host.read(ONLINE) ?? "");
  const missing = req.cpus.filter((c) => !online.includes(c));
  if (missing.length > 0) throw new HelperError(`CPU ${formatCpus(missing)} is not online`);
  checkMem(host, req.mem);
  const rest = without(online, req.cpus);
  if (rest.length < MIN_HOST_CPUS)
    throw new HelperError(
      `the host must keep at least ${MIN_HOST_CPUS} CPUs; --cpus ${formatCpus(req.cpus)} leaves ${rest.length}`,
    );
  for (const cpu of req.cpus) {
    const siblings = parseCpus(host.read(cpuFile(cpu, "topology/thread_siblings_list")) ?? "");
    const split = siblings.filter((s) => !req.cpus.includes(s));
    if (split.length > 0)
      throw new HelperError(
        `CPU ${cpu} shares a core with ${formatCpus(split)}: reserve whole cores`,
      );
  }
  if (host.callerUid === null)
    throw new HelperError("run through sudo: no caller to check --pid against");
  if (host.procUid(req.pid) !== host.callerUid)
    throw new HelperError(`--pid ${req.pid} is not a process of the user who ran sudo`);
  return rest;
}

/** Start the scope around the runner: a transient unit under `-.slice`, outside the user's slice. */
async function startScope(host: Host, pid: number): Promise<void> {
  const r = await host.exec([
    "busctl",
    "call",
    // `-.slice` below would be read as an option without this
    "--",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    SCOPE,
    "fail",
    "3",
    "PIDs",
    "au",
    "1",
    String(pid),
    "Description",
    "s",
    "PixelSlash dedicated benchmark",
    "Slice",
    "s",
    "-.slice",
    "0",
  ]);
  if (r.code !== 0) throw new Error(`starting ${SCOPE}: ${r.err.trim() || r.code}`);
}

async function apply(
  host: Host,
  req: Extract<Request, { cmd: "on" }>,
  rest: number[],
  before: Journal,
): Promise<void> {
  for (const unit of HOST_UNITS)
    await systemctl(host, ["set-property", "--runtime", unit, `AllowedCPUs=${formatCpus(rest)}`]);
  if (before.boost !== null) host.write(BOOST, "0");
  for (const cpu of req.cpus)
    if (!["", "performance"].includes(before.governors[String(cpu)] ?? ""))
      host.write(cpuFile(cpu, "cpufreq/scaling_governor"), "performance");
  await startScope(host, req.pid);
  await systemctl(host, [
    "set-property",
    "--runtime",
    SCOPE,
    `AllowedCPUs=${formatCpus(req.cpus)}`,
    `MemoryMin=${req.mem}`,
    `MemoryMax=${req.mem}`,
    "MemorySwapMax=0",
  ]);
  // The timer starts when `systemd-run` returns, not at the snapshot: the arm stamps the deadline it was given.
  const lapses = await armLapse(host);
  host.write(STATE_FILE, `${JSON.stringify({ ...before, lapses })}\n`);
}

export async function reserveOn(host: Host, req: Extract<Request, { cmd: "on" }>): Promise<string> {
  const rest = checkAgainstHost(host, req);
  host.mkdir(STATE_DIR);
  // The record is the lock against a second `on`; the marker is the lock against `off` and `renew`.
  const release = takeMarker(host);
  if (!host.create(STATE_FILE, "{}\n")) {
    release();
    throw new HelperError("already reserved (or a run died): run `pixelslash-bench-reserve off`");
  }
  try {
    const before = await snapshot(host, req.cpus);
    host.write(STATE_FILE, `${JSON.stringify(before)}\n`);
    await apply(host, req, rest, before);
  } catch (e) {
    throw await releaseAfter(host, e);
  } finally {
    release();
  }
  return `reserved CPUs ${formatCpus(req.cpus)} and ${req.mem} for ${SCOPE}; the host keeps ${formatCpus(rest)}; ends in ${LIFETIME_S / 60} minutes unless renewed`;
}

/** Another helper process holds the marker (one a killed helper left does not count: its process is gone). */
function helperRunning(host: Host): boolean {
  const pid = Number(host.read(ON_FILE));
  const comm = host.read(`/proc/${pid}/comm`) ?? "";
  return pid > 0 && pid !== host.self && comm.startsWith("pixelslash-ben");
}

/**
 * Take the marker that serialises `on`, `off` and `renew`, so no two of them change the machine at once. It is
 * created exclusively, and a marker a killed helper left is cleared and taken over. Returns the release, which
 * removes the marker only while it still holds this process.
 */
function takeMarker(host: Host): () => void {
  const mine = `${host.self}\n`;
  if (!host.create(ON_FILE, mine)) {
    if (helperRunning(host))
      throw new HelperError(
        "another helper is running (on, off or renew); try again when it has finished",
      );
    host.remove(ON_FILE);
    if (!host.create(ON_FILE, mine))
      throw new HelperError("another helper took the marker; try again");
  }
  return () => {
    if (host.read(ON_FILE) === mine) host.remove(ON_FILE);
  };
}

export async function reserveOff(host: Host): Promise<string> {
  host.mkdir(STATE_DIR);
  const release = takeMarker(host);
  try {
    const text = host.read(STATE_FILE);
    if (text === null) return "nothing reserved";
    const journal = readJournal(host);
    if (journal === null) {
      // `{}` is the placeholder `on` writes before it changes anything; any other record is one this
      // helper cannot read (another version), so it stays for a human rather than being lost.
      if (text.trim() !== "{}")
        throw new HelperError(
          `${STATE_FILE} is not a record this helper version can restore from; leaving it, reinstall the matching helper and run off`,
        );
      host.remove(STATE_FILE);
      return "nothing reserved (the record was empty)";
    }
    const failures = await restore(host, journal);
    if (failures.length > 0)
      throw new HelperError(
        `restore incomplete, record kept, run off again: ${failures.join("; ")}`,
      );
    // The timer goes last: until the machine is back, it is the only thing that can end the reservation.
    const unstopped = await stopLapse(host);
    if (unstopped.length > 0)
      throw new HelperError(
        `the machine is back but the lapse stays: ${unstopped.join("; ")}; run off again`,
      );
    host.remove(STATE_FILE);
    return "restored";
  } finally {
    release();
  }
}

/**
 * Move the lapse to LIFETIME_S from now. A timer cannot be edited, so it is stopped and armed again;
 * if that fails the reservation would have no bound, so it is released rather than left unbounded.
 * It holds the marker while it works, so an `off` (a hand-run one, or the lapse's) cannot restore the
 * machine and remove the record between the read and the write at the end.
 */
export async function reserveRenew(host: Host): Promise<string> {
  host.mkdir(STATE_DIR);
  const release = takeMarker(host);
  try {
    const journal = readJournal(host);
    if (journal === null) {
      if (host.read(STATE_FILE) === null) throw new HelperError("nothing reserved");
      throw new HelperError("the record is not usable; run off");
    }
    if (journal.version !== JOURNAL_VERSION)
      throw new HelperError("reserved by an older helper; run off");
    try {
      const lapses = await armLapse(host);
      host.write(STATE_FILE, `${JSON.stringify({ ...journal, lapses })}\n`);
      return `renewed: ends ${new Date(lapses).toISOString()} unless renewed again`;
    } catch (e) {
      // A timer that would not stop is still the bound, so the reservation is left as it is. Only a failed arm
      // leaves it unbounded, and that is released rather than kept.
      if (e instanceof LapseError && e.bounded)
        throw new HelperError(`renew failed, the lapse still stands: ${e.message}`);
      // `releaseAfter` already says whether that worked ("(restored)", or "run off"): do not restate it.
      throw new HelperError(`renew failed: ${(await releaseAfter(host, e)).message}`);
    }
  } finally {
    release();
  }
}

/** The timestamp as epoch ms when a `Date` can represent it, else null. */
function knownMs(ms: number | undefined): number | null {
  return ms !== undefined && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

/** A journal stamp as an ISO time: null when there is none, or when a `Date` cannot hold it. */
function stamp(active: boolean, ms: number | undefined): string | null {
  const at = knownMs(ms);
  return active && at !== null ? new Date(at).toISOString() : null;
}

export async function reserveStatus(host: Host): Promise<string> {
  const journal = readJournal(host);
  const live: Record<string, string> = {};
  for (const unit of HOST_UNITS) live[unit] = await show(host, unit);
  const active = host.read(STATE_FILE) !== null;
  // A record this helper did not write can hold a timestamp no Date can represent: report it as unknown, not a throw.
  const start = knownMs(journal?.started);
  return JSON.stringify({
    version: HELPER_VERSION,
    active,
    reserved: journal?.reserved ?? [],
    allowed: live,
    started: stamp(active, journal?.started),
    lapses: stamp(active, journal?.lapses),
    age_s: active && start !== null ? Math.floor((host.now() - start) / 1000) : null,
  });
}

export async function runHelper(host: Host, argv: string[]): Promise<string> {
  const req = parseRequest(argv);
  if (req.cmd === "on") return reserveOn(host, req);
  if (req.cmd === "off") return reserveOff(host);
  return req.cmd === "renew" ? reserveRenew(host) : reserveStatus(host);
}
