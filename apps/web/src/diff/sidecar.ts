import { Buffer } from "node:buffer";
import type { DiffIgnore, DiffOptions, PixelDiff } from "@hackcove/pixelslash-engine/diff";
import { release } from "@hackcove/pixelslash-engine/release";
import { warn } from "#/lib/log";
import { reportError } from "#/server/sentry";
import { callGate } from "./call-gate";
import { SIDECAR_PATH, decodeResponse, encodeRequest } from "./sidecar-wire";

/**
 * The self-host's diff sidecar client (PS-203). A self-host runs the engine's diff in a Bun process
 * on loopback (`deploy/ssh/diff-sidecar.ts`), outside workerd's memory, and the Worker sends it each
 * shot's two PNGs. Cloudflare never sets `DIFF_SIDECAR_URL`, so there it is never called.
 */

/** The diff the sidecar runs, or a reason it could not (the caller may then measure in-process). */
export type SidecarDiff = (
  main: Buffer,
  branch: Buffer,
  options: DiffOptions,
  ignore: DiffIgnore,
) => Promise<PixelDiff>;

/**
 * Far above a diff's own time (a 1280x16800 page is ~0.5 s, ~4.5 s with every pixel changed) and below the Worker budget's slowest
 * shot: a sidecar that hangs costs this once per run, then the in-process diff measures what its
 * limit allows (`compare.ts`).
 */
const TIMEOUT_MS = 15_000;

/**
 * How many calls wait on the sidecar at once (PS-325). It diffs one at a time, so a call also waits
 * for every call ahead of it there: a 1280x16800 page with every pixel changed is ~3.9 s, so the
 * fourth caller's answer took 15.7 s, past `TIMEOUT_MS`, on a sidecar that was working. The queue is
 * kept here instead, where a wait is not on the call's clock and reads as neither slow nor down.
 * One, not two: two finished the same load ~10% sooner, but a call's clock then also holds the diff
 * ahead of it, and two slow diffs under load (7.8 s each, measured) reach `TIMEOUT_MS` again.
 */
const MAX_CALLS = 1;
/** The call's own timeout and a margin: a call cancelled with its request frees its place by then. */
const gate = callGate(MAX_CALLS, TIMEOUT_MS + 1000);

/**
 * Why the sidecar gave no result. `unreachable` and `error` are logged once per kind; `rejected` is
 * a file the sidecar could not diff (HTTP 422), which the in-process diff then reports in the same words.
 */
type Kind = "unreachable" | "error" | "rejected";

export class SidecarError extends Error {
  readonly kind: Kind;
  constructor(kind: Kind, message: string) {
    super(message);
    this.name = "SidecarError";
    this.kind = kind;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The diff endpoint of a sidecar URL, or null when it is not plain http on this machine: a typo in
 * `DIFF_SIDECAR_URL` must not send shots to another host (invariant 4).
 */
export function sidecarEndpoint(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(SIDECAR_PATH, url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname) ? parsed.toString() : null;
}

/** The sidecar at `endpoint`, as `sidecarEndpoint` gives it. */
export function sidecarDiff(endpoint: string, deps: { timeoutMs?: number } = {}): SidecarDiff {
  return (main, branch, options, ignore) =>
    gate(async () => {
      const body = encodeRequest({ main, branch, options, ignore });
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body,
          signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (e) {
        throw new SidecarError("unreachable", `${endpoint}: ${messageOf(e)}`);
      } finally {
        // A copy of both uploads, sent and dead: freed now, as the uploads are (PS-200).
        release(body);
      }
      if (!res.ok) {
        const said = (await res.text().catch(() => "")).slice(0, 300);
        const kind = res.status === 422 ? "rejected" : "error";
        throw new SidecarError(kind, `${endpoint}: HTTP ${res.status} ${said}`);
      }
      try {
        return decodeResponse(Buffer.from(await res.arrayBuffer()));
      } catch (e) {
        throw new SidecarError("error", `${endpoint}: ${messageOf(e)}`);
      }
    });
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const logged = new Set<string>();

/**
 * Why a diff ran in-process, said once per isolate and kind: a burst of 50 shots against a sidecar
 * that is down is one journal line, not 50. Unset is said too, once, so a self-host that meant to
 * set it can see it did not.
 */
export function logFallbackOnce(
  kind: "unset" | "refused" | "unreachable" | "error",
  message: string,
): void {
  if (logged.has(kind)) return;
  logged.add(kind);
  warn(`server diff: in-process (${kind}): ${message}`);
  // Unset and refused are a deployment's choice; a sidecar that is down or errors is a fault (PS-227).
  if (kind === "unreachable" || kind === "error")
    reportError(new Error(`diff sidecar ${kind}: ${message}`), { area: "diff-sidecar", kind });
}

/** For tests: forget what was logged. */
export function resetFallbackLog(): void {
  logged.clear();
}
