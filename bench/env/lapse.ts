/** The timer that ends a reservation, so a forgotten one cannot squeeze the desktop for good. */
import type { Host } from "./machine.ts";

/** How long a reservation lasts before systemd ends it, unless `renew` moves it. */
export const LIFETIME_S = 1800;
export const LAPSE_UNIT = "pixelslash-bench-lapse";

/** A lapse that could not be moved. `bounded` is true while the timer it already had is still waiting, so the
 * reservation is not unbounded and does not need to be released. */
export class LapseError extends Error {
  constructor(
    message: string,
    readonly bounded: boolean,
  ) {
    super(message);
  }
}

/** `systemctl stop` of a unit that may not be loaded: that is fine, anything else is not. */
export async function stopUnit(host: Host, unit: string): Promise<string | null> {
  const stopped = await host.exec(["systemctl", "stop", unit]);
  const fine = stopped.code === 0 || /not loaded|not found/i.test(stopped.err);
  return fine ? null : `systemctl stop ${unit}: ${stopped.err.trim() || stopped.code}`;
}

/** Arm the timer that runs `off` LIFETIME_S from now, replacing one a failed `off` left behind. Returns the
 * deadline it was armed for: stamped before the call that starts it, so it is never later than the timer. */
export async function armLapse(host: Host): Promise<number> {
  const left = await stopUnit(host, `${LAPSE_UNIT}.timer`);
  if (left !== null) throw new LapseError(left, true);
  const lapses = host.now() + LIFETIME_S * 1000;
  const r = await host.exec([
    "systemd-run",
    `--unit=${LAPSE_UNIT}`,
    `--on-active=${LIFETIME_S}s`,
    "--timer-property=AccuracySec=1s",
    "--collect",
    host.selfPath,
    "off",
  ]);
  if (r.code !== 0) throw new LapseError(`arming ${LAPSE_UNIT}: ${r.err.trim() || r.code}`, false);
  return lapses;
}
