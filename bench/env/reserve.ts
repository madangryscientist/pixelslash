/**
 * `pixelslash-bench-reserve on|off|status` (ob 1947): the one root step of `bench:perf --env dedicated`.
 * It takes whole cores out of the host's CPU sets, puts the caller's runner in a scope that owns
 * them with its memory guaranteed, turns boost off and keeps the performance governor, and puts
 * all of it back on `off`. Everything is `--runtime`, so a reboot undoes it too.
 *
 * Root runs this through one sudoers line, so it takes no free-form input: three flags, each
 * validated here, and every command it runs is a fixed argv (no shell). All effects go through
 * `Host`, which a test replaces; the real one is ./host.ts. `off` is a full restore from the
 * journal `on` wrote before it changed anything, so it is safe to run twice, after a crash, or
 * when `on` never finished.
 */
import { formatCpus, parseCpus, without } from "./cpulist.ts";

/** Bumped when the helper's behaviour changes; the runner refuses a helper that does not match. */
export const HELPER_VERSION = 2;
/** The shape of the journal in /run, which outlives a reinstall: it changes only when the shape does. */
const JOURNAL_VERSION = 1;
export const SCOPE = "pixelslash-bench.scope";
export const HOST_UNITS = ["system.slice", "user.slice", "init.scope"] as const;
export const STATE_DIR = "/run/pixelslash-bench";
export const STATE_FILE = `${STATE_DIR}/state.json`;
/** Written for as long as an `on` runs, so a hand-run `off` cannot restore under it. */
export const ON_FILE = `${STATE_DIR}/on.pid`;
export const DEFAULT_CPUS = "4,5,10,11";
export const DEFAULT_MEM = "4G";

const BOOST = "/sys/devices/system/cpu/cpufreq/boost";
const ONLINE = "/sys/devices/system/cpu/online";
const cpuFile = (cpu: number, leaf: string): string => `/sys/devices/system/cpu/cpu${cpu}/${leaf}`;
const dropIn = (unit: string): string =>
  `/run/systemd/system.control/${unit}.d/50-AllowedCPUs.conf`;

export type Out = { code: number; out: string; err: string };

/** Everything the helper does to the machine. */
export type Host = {
  exec(cmd: string[]): Promise<Out>;
  /** The file's text, or null when it is not there. */
  read(path: string): string | null;
  write(path: string, text: string): void;
  /** Create `path` only if it does not exist; false when it does. */
  create(path: string, text: string): boolean;
  remove(path: string): void;
  mkdir(path: string): void;
  /** Owner of the process, or null when there is no such process. */
  procUid(pid: number): number | null;
  /** The user who ran sudo, or null when not run through sudo. */
  callerUid: number | null;
  /** This helper's own process id. */
  self: number;
  /** Whether this process is itself inside the scope (the runner called it from there). */
  insideScope(): boolean;
};

/** A request that cannot be honoured: the message is for the person at the terminal. */
export class HelperError extends Error {}

export type Request =
  | { cmd: "on"; cpus: number[]; mem: string; pid: number }
  | { cmd: "off" }
  | { cmd: "status" };

const FLAGS = ["--cpus", "--mem", "--pid"];

export function parseRequest(argv: string[]): Request {
  const [cmd, ...rest] = argv;
  if (cmd === "off" || cmd === "status") {
    if (rest.length > 0) throw new HelperError(`${cmd} takes no arguments`);
    return { cmd };
  }
  if (cmd !== "on") throw new HelperError("usage: pixelslash-bench-reserve on|off|status");
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
  if (rest.length < 2) throw new HelperError("the host must keep at least two CPUs");
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

/** What the machine looked like before `on`: the one thing `off` needs. */
type Journal = {
  version: number;
  reserved: number[];
  /** Per host unit; "" is "not set". */
  allowed: Record<string, string>;
  boost: string | null;
  governors: Record<string, string>;
};

async function show(host: Host, unit: string): Promise<string> {
  const r = await host.exec(["systemctl", "show", "-p", "AllowedCPUs", "--value", unit]);
  if (r.code !== 0) throw new HelperError(`systemctl show ${unit}: ${r.err}`);
  const value = r.out.trim();
  return value === "[not set]" ? "" : value;
}

async function snapshot(host: Host, reserved: number[]): Promise<Journal> {
  const allowed: Record<string, string> = {};
  for (const unit of HOST_UNITS) allowed[unit] = await show(host, unit);
  const governors: Record<string, string> = {};
  for (const cpu of reserved)
    governors[String(cpu)] = (host.read(cpuFile(cpu, "cpufreq/scaling_governor")) ?? "").trim();
  return {
    version: JOURNAL_VERSION,
    reserved,
    allowed,
    boost: host.read(BOOST)?.trim() ?? null,
    governors,
  };
}

async function systemctl(host: Host, args: string[]): Promise<void> {
  const r = await host.exec(["systemctl", ...args]);
  if (r.code !== 0) throw new Error(`systemctl ${args.join(" ")}: ${r.err.trim() || r.code}`);
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
}

function readJournal(host: Host): Journal | null {
  const text = host.read(STATE_FILE);
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return isJournal(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isJournal(raw: unknown): raw is Journal {
  if (typeof raw !== "object" || raw === null) return false;
  const allowed: unknown = Reflect.get(raw, "allowed");
  return (
    Reflect.get(raw, "version") === JOURNAL_VERSION &&
    Array.isArray(Reflect.get(raw, "reserved")) &&
    typeof allowed === "object" &&
    allowed !== null &&
    HOST_UNITS.every((u) => /^[0-9 ,-]*$/.test(String(Reflect.get(allowed, u))))
  );
}

/** Put one host unit's CPU set back; an unset one loses its drop-in too. Returns whether a drop-in went. */
async function restoreUnit(host: Host, unit: string, prior: string): Promise<boolean> {
  await systemctl(host, ["set-property", "--runtime", unit, `AllowedCPUs=${prior}`]);
  if (prior !== "") return false;
  host.remove(dropIn(unit));
  return true;
}

/** Called from inside the scope (the runner's own `off`), stopping it would kill the caller: it ends with the runner. From outside (a stale run) the processes in it go. */
async function stopScope(host: Host): Promise<string[]> {
  if (host.insideScope()) return [];
  const stopped = await host.exec(["systemctl", "stop", SCOPE]);
  const fine = stopped.code === 0 || /not loaded|not found/i.test(stopped.err);
  return fine ? [] : [`systemctl stop ${SCOPE}: ${stopped.err.trim()}`];
}

/** Undo `on` from its journal. Every step runs even if an earlier one failed; the failures come back together. */
async function restore(host: Host, journal: Journal): Promise<string[]> {
  const failures = await stopScope(host);
  const step = async (what: () => unknown): Promise<unknown> => {
    try {
      return await what();
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
  let dropped = false;
  for (const unit of HOST_UNITS)
    dropped =
      (await step(() => restoreUnit(host, unit, journal.allowed[unit] ?? ""))) === true || dropped;
  if (dropped) await step(() => systemctl(host, ["daemon-reload"]));
  if (journal.boost !== null) await step(() => host.write(BOOST, journal.boost ?? ""));
  for (const [cpu, governor] of Object.entries(journal.governors))
    if (governor !== "" && /^[0-9]+$/.test(cpu))
      await step(() => host.write(cpuFile(Number(cpu), "cpufreq/scaling_governor"), governor));
  return failures;
}

export async function reserveOn(host: Host, req: Extract<Request, { cmd: "on" }>): Promise<string> {
  const rest = checkAgainstHost(host, req);
  host.mkdir(STATE_DIR);
  if (!host.create(STATE_FILE, "{}\n"))
    throw new HelperError("already reserved (or a run died): run `pixelslash-bench-reserve off`");
  host.write(ON_FILE, `${host.self}\n`);
  try {
    const before = await snapshot(host, req.cpus);
    host.write(STATE_FILE, `${JSON.stringify(before)}\n`);
    await apply(host, req, rest, before);
  } catch (e) {
    const journal = readJournal(host);
    const failures = journal ? await restore(host, journal) : [];
    if (failures.length === 0) host.remove(STATE_FILE);
    const why = e instanceof Error ? e.message : String(e);
    throw new HelperError(
      failures.length === 0
        ? `${why} (restored)`
        : `${why}; restoring also failed: ${failures.join("; ")}; run off`,
    );
  } finally {
    host.remove(ON_FILE);
  }
  return `reserved CPUs ${formatCpus(req.cpus)} and ${req.mem} for ${SCOPE}; the host keeps ${formatCpus(rest)}`;
}

/** Another helper process is in the middle of `on` (a record left by a killed one does not count). */
function onRunning(host: Host): boolean {
  const pid = Number(host.read(ON_FILE));
  const comm = host.read(`/proc/${pid}/comm`) ?? "";
  return pid > 0 && pid !== host.self && comm.startsWith("pixelslash-ben");
}

export async function reserveOff(host: Host): Promise<string> {
  if (onRunning(host))
    throw new HelperError("an `on` is still running; run off when it has finished");
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
    throw new HelperError(`restore incomplete, record kept, run off again: ${failures.join("; ")}`);
  host.remove(STATE_FILE);
  return "restored";
}

export async function reserveStatus(host: Host): Promise<string> {
  const journal = readJournal(host);
  const live: Record<string, string> = {};
  for (const unit of HOST_UNITS) live[unit] = await show(host, unit);
  return JSON.stringify({
    version: HELPER_VERSION,
    active: host.read(STATE_FILE) !== null,
    reserved: journal?.reserved ?? [],
    allowed: live,
  });
}

export async function runHelper(host: Host, argv: string[]): Promise<string> {
  const req = parseRequest(argv);
  if (req.cmd === "on") return reserveOn(host, req);
  return req.cmd === "off" ? reserveOff(host) : reserveStatus(host);
}
