/**
 * The capture stage (ob 1489): does the pinned capture image's stabilisation (animations off, caret
 * hidden, frozen clock, settle) remove the noise the diff would otherwise be scored on?
 *
 * Each fixture page is captured in pairs (PAIRS of them) with `pixelslash capture` in three arms and
 * each pair is diffed with the engine:
 *   image    the pinned image (docker/capture), default stabilisation
 *   bare     the same CLI on this machine, default stabilisation
 *   control  the same CLI on this machine with stabilisation off (the settle stays; it is not optional)
 * The control is what makes a clean `image` row mean something: it shows the page does flicker.
 * Argos is not involved. Needs Docker; `runCaptureStage` says why and returns null when it is absent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_PAGES, servePages, type CapturePage } from "./capture-pages.ts";
import { BENCH_DIR } from "./corpus.ts";
import { pixelslashDiff } from "./pixelslash.ts";
import type { Rect } from "./regions.ts";
import { say } from "./say.ts";

export const IMAGE_TAG = "pixelslash-capture:dev";
const ROOT = join(BENCH_DIR, "..");
const CLI = join(ROOT, "packages", "cli", "src", "index.ts");

export const ARMS = ["image", "bare", "control"] as const;
export type Arm = (typeof ARMS)[number];

/** Pairs captured per page and arm. Some noise is a coin toss per capture, so one pair can pass by luck. */
export const PAIRS = 3;

/** What two captures of one page in one arm came to. */
export type PairOutcome =
  | { kind: "diffed"; changedPx: number; regions: Rect[]; sizeMismatch: boolean }
  | { kind: "failed"; error: string };

export type CaptureStageRow = { page: CapturePage; arms: Record<Arm, PairOutcome[]> };

export type CaptureStage = {
  rows: CaptureStageRow[];
  imageVersion: string;
};

/** True when the outcome is a false change: the pair differs, or a capture did not finish. */
export const flickers = (o: PairOutcome): boolean =>
  o.kind === "failed" || o.changedPx > 0 || o.sizeMismatch;

/** How many of an arm's pairs were falsely flagged. */
export const flagged = (pairs: PairOutcome[]): number => pairs.filter(flickers).length;

type Run = { code: number; out: string; err: string };

async function run(cmd: string[]): Promise<Run> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/** Why the stage cannot run, or null when it can. */
async function dockerProblem(): Promise<string | null> {
  if (!Bun.which("docker")) return "docker is not installed";
  const info = await run(["docker", "info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) return `docker is not reachable (${info.err.trim().split("\n")[0]})`;
  return null;
}

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

function configFor(origin: string, page: CapturePage, stabilised: boolean): string {
  return JSON.stringify({
    baseUrl: origin,
    routes: [{ path: `/${page.name}.html`, name: page.name }],
    variants: [{ name: "shot", viewport: { width: 1280, height: 720 } }],
    ...(stabilised ? {} : { stabilise: { animations: false, caret: false, clock: false } }),
  });
}

type Job = { arm: Arm; page: CapturePage; run: number };

/** One `pixelslash capture`, in the image or on this machine. Returns the PNG bytes or the error. */
async function capture(job: Job, origin: string, work: string): Promise<Buffer | string> {
  const dir = join(work, job.arm, job.page.name, String(job.run));
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, configFor(origin, job.page, job.arm !== "control"));
  const out = join(dir, "out");
  const cmd =
    job.arm === "image"
      ? [
          "docker",
          "run",
          "--rm",
          "--network",
          "host",
          "--user",
          `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
          "-v",
          `${dir}:/work`,
          IMAGE_TAG,
          "capture",
          "--config",
          "/work/config.json",
          "--out",
          "/work/out",
        ]
      : ["bun", CLI, "capture", "--config", config, "--out", out];
  const res = await run(cmd);
  if (res.code !== 0) return lastLine(res.err) || `exit ${res.code}`;
  return readFileSync(join(out, job.page.name, "shot.png"));
}

async function outcome(
  job: { arm: Arm; page: CapturePage; pair: number },
  origin: string,
  work: string,
): Promise<PairOutcome> {
  const { arm, page, pair } = job;
  const first = await capture({ arm, page, run: 2 * pair - 1 }, origin, work);
  const second = await capture({ arm, page, run: 2 * pair }, origin, work);
  const failed = [first, second].find((r) => typeof r === "string");
  if (typeof failed === "string") return { kind: "failed", error: failed };
  if (typeof first === "string" || typeof second === "string") throw new Error("unreachable");
  const diff = pixelslashDiff(first, second);
  return {
    kind: "diffed",
    changedPx: Number(diff.note.split(" ")[0]),
    regions: diff.regions,
    sizeMismatch: diff.sizeMismatch,
  };
}

async function pairsFor(
  arm: Arm,
  page: CapturePage,
  origin: string,
  work: string,
): Promise<PairOutcome[]> {
  const pairs: PairOutcome[] = [];
  for (let pair = 1; pair <= PAIRS; pair++)
    pairs.push(await outcome({ arm, page, pair }, origin, work));
  return pairs;
}

/** Build the image from this tree (layers are cached, so this is quick when only sources moved). */
async function buildImage(): Promise<string | null> {
  const build = await run([
    "docker",
    "build",
    "--quiet",
    "-f",
    join(ROOT, "docker", "capture", "Dockerfile"),
    "-t",
    IMAGE_TAG,
    ROOT,
  ]);
  return build.code === 0 ? null : lastLine(build.err);
}

async function imageVersion(): Promise<string> {
  const res = await run(["docker", "image", "inspect", "--format", "{{.Id}}", IMAGE_TAG]);
  return res.code === 0 ? res.out.trim().slice(0, 19) : "unknown";
}

/** Null (after saying why) when Docker or the image is unavailable. */
export async function runCaptureStage(): Promise<CaptureStage | null> {
  const problem = await dockerProblem();
  if (problem) {
    say(`capture: skip: ${problem}`);
    return null;
  }
  say(`capture: building ${IMAGE_TAG}`);
  const buildError = await buildImage();
  if (buildError) {
    say(`capture: skip: could not build ${IMAGE_TAG} (${buildError})`);
    return null;
  }
  const work = mkdtempSync(join(tmpdir(), "pixelslash-bench-capture-"));
  const pages = servePages();
  try {
    const rows: CaptureStageRow[] = [];
    for (const page of CAPTURE_PAGES) {
      say(`capture: ${page.name}`);
      const arms = {
        image: await pairsFor("image", page, pages.origin, work),
        bare: await pairsFor("bare", page, pages.origin, work),
        control: await pairsFor("control", page, pages.origin, work),
      };
      rows.push({ page, arms });
    }
    return {
      rows,
      imageVersion: await imageVersion(),
    };
  } finally {
    pages.stop();
    rmSync(work, { recursive: true, force: true });
  }
}
