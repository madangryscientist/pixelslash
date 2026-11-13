/** Putting the machine back: the restore half of the reserve helper, for `off` and for a failed `on` or `renew`. */
import { HelperError } from "./error.ts";
import { BOOST, cpuFile, HOST_UNITS, readJournal, STATE_FILE, type Journal } from "./journal.ts";
import { LAPSE_UNIT, stopUnit } from "./lapse.ts";
import { SCOPE, systemctl, type Host } from "./machine.ts";

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The drop-in `systemctl set-property --runtime` writes for a unit that had no CPU set. */
const dropIn = (unit: string): string =>
  `/run/systemd/system.control/${unit}.d/50-AllowedCPUs.conf`;

/** Put one host unit's CPU set back; an unset one loses its drop-in too. Returns whether a drop-in went. */
async function restoreUnit(host: Host, unit: string, prior: string): Promise<boolean> {
  await systemctl(host, ["set-property", "--runtime", unit, `AllowedCPUs=${prior}`]);
  if (prior !== "") return false;
  host.remove(dropIn(unit));
  return true;
}

/** Called from inside the scope (the runner's own `off`), stopping it would kill the caller: it ends with the
 * runner. From outside (a stale run) the processes in it go. */
async function stopScope(host: Host): Promise<string[]> {
  if (host.insideScope()) return [];
  const failed = await stopUnit(host, SCOPE);
  return failed === null ? [] : [failed];
}

/**
 * Undo `on` from its journal. Every step runs even if an earlier one failed; the failures come back together.
 * The lapse timer is stopped by the caller only after this has succeeded, so a failed restore keeps the bound
 * the reservation already had instead of leaving a squeezed host with nothing to end it.
 */
export async function restore(host: Host, journal: Journal): Promise<string[]> {
  const failures = await stopScope(host);
  const step = async (what: () => unknown): Promise<unknown> => {
    try {
      return await what();
    } catch (e) {
      failures.push(why(e));
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

/** Stop the lapse timer: the last step of a restore, so a stop that fails is one more reason to keep the record.
 * A lapse's own `off` finds its own timer already gone, which is fine. */
export async function stopLapse(host: Host): Promise<string[]> {
  const failed = await stopUnit(host, `${LAPSE_UNIT}.timer`);
  return failed === null ? [] : [failed];
}

/** Put everything back after a step failed; the error to throw says whether that worked. */
export async function releaseAfter(host: Host, e: unknown): Promise<HelperError> {
  const journal = readJournal(host);
  let failures = journal ? await restore(host, journal) : [];
  if (failures.length === 0) failures = await stopLapse(host);
  if (failures.length === 0) host.remove(STATE_FILE);
  return new HelperError(
    failures.length === 0
      ? `${why(e)} (restored)`
      : `${why(e)}; restoring also failed: ${failures.join("; ")}; run off`,
  );
}
