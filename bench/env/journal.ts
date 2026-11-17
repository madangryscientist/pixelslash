/** The record `on` writes in /run before it changes anything, and the one `off` restores from. */
import { HelperError } from "./error.ts";
import { LIFETIME_S } from "./lapse.ts";
import type { Host } from "./machine.ts";

/** The shape of the journal in /run, which outlives a reinstall: it changes only when the shape does. */
export const JOURNAL_VERSION = 2;
export const HOST_UNITS = ["system.slice", "user.slice", "init.scope"] as const;
export const STATE_DIR = "/run/pixelslash-bench";
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const BOOST = "/sys/devices/system/cpu/cpufreq/boost";
export const cpuFile = (cpu: number, leaf: string): string =>
  `/sys/devices/system/cpu/cpu${cpu}/${leaf}`;
/** What the machine looked like before `on`: the one thing `off` needs. */
export type Journal = {
  version: number;
  reserved: number[];
  /** Per host unit; "" is "not set". */
  allowed: Record<string, string>;
  boost: string | null;
  governors: Record<string, string>;
  /** Epoch ms of `on` and of the moment the lapse timer fires; a version 1 record has neither. */
  started?: number;
  lapses?: number;
};

export async function show(host: Host, unit: string): Promise<string> {
  const r = await host.exec(["systemctl", "show", "-p", "AllowedCPUs", "--value", unit]);
  if (r.code !== 0) throw new HelperError(`systemctl show ${unit}: ${r.err}`);
  const value = r.out.trim();
  return value === "[not set]" ? "" : value;
}

export async function snapshot(host: Host, reserved: number[]): Promise<Journal> {
  const started = host.now();
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
    started,
    lapses: started + LIFETIME_S * 1000,
  };
}

export function readJournal(host: Host): Journal | null {
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
    [1, JOURNAL_VERSION].includes(Number(Reflect.get(raw, "version"))) &&
    Array.isArray(Reflect.get(raw, "reserved")) &&
    typeof allowed === "object" &&
    allowed !== null &&
    HOST_UNITS.every((u) => /^[0-9 ,-]*$/.test(String(Reflect.get(allowed, u)))) &&
    (Reflect.get(raw, "version") === 1 ||
      (Number.isFinite(Reflect.get(raw, "started")) && Number.isFinite(Reflect.get(raw, "lapses"))))
  );
}
