import type { BuildTimings, TimedSettle } from "#/db/schema";

type Obj = Record<string, unknown>;
type Batch = NonNullable<BuildTimings["upload"]>["batches"][number];
type Parts = Partial<Record<(typeof CAPTURE_PARTS)[number], number>> & { settle?: TimedSettle };

const MAX_TIMED_SHOTS = 5000;
const MAX_BATCHES = 20;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ms(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e10;
}

function count(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100000;
}

function load(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function steps(o: Obj): Pick<BuildTimings, "captureMs" | "diffMs" | "judgeMs"> | undefined {
  const out: Pick<BuildTimings, "captureMs" | "diffMs" | "judgeMs"> = {};
  for (const k of ["captureMs", "diffMs", "judgeMs"] as const) {
    if (o[k] === undefined) continue;
    if (!ms(o[k])) return undefined;
    out[k] = Math.round(o[k]);
  }
  return out;
}

const CAPTURE_PARTS = [
  "navigateMs",
  "settleMs",
  "screenshotMs",
  "setupMs",
  "storyMs",
  "measureMs",
] as const;

/** The settle split when all four conditions are well formed; otherwise none. */
function settleOf(split: unknown): TimedSettle | undefined {
  if (!isObj(split)) return undefined;
  const { fontsMs, imagesMs, networkIdleMs, framesMs } = split;
  if (!ms(fontsMs) || !ms(imagesMs) || !ms(networkIdleMs) || !ms(framesMs)) return undefined;
  return {
    fontsMs: Math.round(fontsMs),
    imagesMs: Math.round(imagesMs),
    networkIdleMs: Math.round(networkIdleMs),
    framesMs: Math.round(framesMs),
  };
}

/**
 * The parts of a capture and the settle split, on a run or on a shot. They are extras: one that is
 * absent or malformed is left out, and the rest of the object is kept.
 */
function captureParts(o: Obj): Parts {
  const out: Parts = {};
  for (const k of CAPTURE_PARTS) {
    const v = o[k];
    if (ms(v)) out[k] = Math.round(v);
  }
  const settle = settleOf(o.settle);
  if (settle) out.settle = settle;
  return out;
}

function timedShot(s: unknown): BuildTimings["shots"][number] | undefined {
  if (!isObj(s) || typeof s.name !== "string" || s.name.length > 300) return undefined;
  const own = steps(s);
  return own && { name: s.name, ...own, ...captureParts(s) };
}

const BATCH_SPREAD = ["p50Ms", "p90Ms", "maxMs", "wallMs"] as const;

function batch(b: unknown): Batch | undefined {
  if (!isObj(b) || typeof b.step !== "string" || b.step.length > 100) return undefined;
  if (!ms(b.count) || !ms(b.ms)) return undefined;
  const out: Batch = { step: b.step, count: Math.round(b.count), ms: Math.round(b.ms) };
  // The spread is an extra: a malformed one is dropped, the kind's count and time stay.
  for (const k of BATCH_SPREAD) {
    const v = b[k];
    if (ms(v)) out[k] = Math.round(v);
  }
  return out;
}

function uploadTiming(up: unknown): BuildTimings["upload"] | undefined {
  if (!isObj(up) || !ms(up.totalMs) || !Array.isArray(up.batches)) return undefined;
  if (up.batches.length > MAX_BATCHES) return undefined;
  const batches = up.batches.map(batch);
  return batches.every((b) => b !== undefined)
    ? { totalMs: Math.round(up.totalMs), batches }
    : undefined;
}

/** How many shots and requests ran at once, each kept only when it is a whole count. */
function workersOf(w: unknown): BuildTimings["workers"] | undefined {
  if (!isObj(w)) return undefined;
  const workers: NonNullable<BuildTimings["workers"]> = {};
  if (count(w.capture)) workers.capture = w.capture;
  if (count(w.upload)) workers.upload = w.upload;
  return Object.keys(workers).length > 0 ? workers : undefined;
}

/** The host, only when its cores and both load readings are well formed. */
function hostOf(h: unknown): BuildTimings["host"] | undefined {
  if (!isObj(h) || !count(h.cores) || !load(h.loadStart) || !load(h.loadEnd)) return undefined;
  return { cores: h.cores, loadStart: round2(h.loadStart), loadEnd: round2(h.loadEnd) };
}

/** The run-level extras the CLI sends beside its steps; each is kept only when it is well formed. */
function runExtras(raw: Obj): Partial<BuildTimings> {
  const workers = workersOf(raw.workers);
  const host = hostOf(raw.host);
  return {
    ...(ms(raw.browserLaunchMs) && { browserLaunchMs: Math.round(raw.browserLaunchMs) }),
    ...(ms(raw.captureWallMs) && { captureWallMs: Math.round(raw.captureWallMs) }),
    ...(workers && { workers }),
    ...(host && { host }),
    ...captureParts(raw),
  };
}

/**
 * The CLI's timings (ob 1791), or null. They are an extra: anything that is not the shape the CLI
 * sends is dropped whole rather than failing the finalize. The parts added later (the capture
 * wall, workers, host, capture parts and request spread) are extras of the extra: a malformed one
 * is dropped alone, and a body without them is stored as it always was.
 */
export function parseTimings(raw: unknown): BuildTimings | null {
  if (!isObj(raw) || !ms(raw.totalMs) || !Array.isArray(raw.shots)) return null;
  if (raw.shots.length > MAX_TIMED_SHOTS) return null;
  const total = steps(raw);
  const shots = raw.shots.map(timedShot);
  if (!total || !shots.every((s) => s !== undefined)) return null;
  const timings: BuildTimings = {
    totalMs: Math.round(raw.totalMs),
    ...total,
    ...runExtras(raw),
    shots,
  };
  if (raw.upload === undefined) return timings;
  const upload = uploadTiming(raw.upload);
  return upload ? { ...timings, upload } : null;
}
