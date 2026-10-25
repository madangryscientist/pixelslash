/**
 * diff.wasm timed in workerd (PS-204's harness, restored minimal in PS-212 after PS-210 removed
 * it with pngjs). On demand only, never in the gate:
 *
 *   cd apps/web && bun perf/diff-wasm/run.ts [--rounds 15]
 *
 * It builds `worker.ts` with the Cloudflare Vite plugin and serves it with `vite preview` (one
 * workerd). Every page is first checked against the same diff in Bun: every field and the
 * overlay's sha256. Then each round diffs every page and a no-op request; each request is timed
 * from here and the median of the rounds is reported, with the workerd's RSS and peak (VmHWM).
 * Raw samples go to the gitignored `bench/perf-results/`. For an A/B of a change to the module,
 * run it in a checkout of each side.
 */
import { createHash } from "node:crypto";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wasmDiff } from "@pixelslash/engine/diff-wasm";
import { DIFF_SIZES, page } from "../../../../bench/src/perf/fixtures.ts";

const here = import.meta.dirname;
const web = join(here, "../..");
const config = join(here, "vite.config.ts");
const MARKER = "PIXELSLASH_DIFF_WASM_BENCH";
const PORT = 4192;

const at = process.argv.indexOf("--rounds");
const ROUNDS = at === -1 ? 15 : Number(process.argv[at + 1]);
const WARMUP = 3;

/** The perf pages and their seeds (`writeFixtures`). */
const PAGES = Object.entries(DIFF_SIZES).map(([name, { width, height }], i) => ({
  name: name.replace("diff-", ""),
  main: page(width, height, 100 + i, false),
  branch: page(width, height, 100 + i, true),
}));

async function ready(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`workerd did not start on :${PORT}`);
}

/** VmRSS and VmHWM in MB of the workerd this run started. */
function memory(): { rss: number; peak: number } {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${pid}/comm`, "utf8").startsWith("workerd")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`${MARKER}=${PORT}\0`)) continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN);
      return { rss: kb("VmRSS") / 1024, peak: kb("VmHWM") / 1024 };
    } catch {
      // A process that exited while it was read.
    }
  }
  throw new Error(`no workerd for :${PORT}`);
}

async function request(impl: string, name: string, check = false): Promise<string> {
  const url = `http://127.0.0.1:${PORT}/run?impl=${impl}&page=${name}${check ? "&check" : ""}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${impl} ${name}: ${response.status} ${await response.text()}`);
  return response.text();
}

async function load(): Promise<void> {
  for (const { name, main, branch } of PAGES) {
    const response = await fetch(`http://127.0.0.1:${PORT}/load?page=${name}`, {
      method: "POST",
      headers: { "x-main-length": String(main.length) },
      body: Buffer.concat([main, branch]),
    });
    if (!response.ok) throw new Error(`load ${name}: ${response.status}`);
  }
}

/** The same answer in workerd as in Bun before any time is taken. */
async function checkEqual(): Promise<void> {
  for (const { name, main, branch } of PAGES) {
    const { overlay, ...result } = wasmDiff([main, branch]);
    const want = JSON.stringify({
      result,
      overlay: createHash("sha256").update(overlay).digest("hex"),
    });
    const got = JSON.stringify(JSON.parse(await request("wasm", name, true)));
    if (got !== want) throw new Error(`${name}: workerd and Bun differ`);
  }
}

/** One round: every page, the wasm diff and the no-op in turn, the order flipped each round. */
async function time(round: number, samples: Record<string, number[]>): Promise<void> {
  for (const { name } of PAGES) {
    for (const impl of round % 2 ? ["noop", "wasm"] : ["wasm", "noop"]) {
      const start = performance.now();
      await request(impl, name);
      const ms = performance.now() - start;
      if (round >= WARMUP) (samples[`${impl} ${name}`] ??= []).push(ms);
    }
  }
}

const median = (samples: number[] = []) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] ?? NaN)
    : ((sorted[mid - 1] ?? NaN) + (sorted[mid] ?? NaN)) / 2;
};

const say = (line = "") => process.stdout.write(`${line}\n`);
const mb = (m: { rss: number; peak: number }) => `${m.rss.toFixed(0)} / ${m.peak.toFixed(0)} MB`;

const build = spawnSync("bunx", ["vite", "build", "--config", config], {
  cwd: web,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("vite build failed");

const args = ["vite", "preview", "--config", config, "--host", "127.0.0.1"];
const child: ChildProcess = spawn("bunx", [...args, "--port", String(PORT), "--strictPort"], {
  cwd: web,
  env: { ...process.env, [MARKER]: String(PORT) },
  stdio: "inherit",
});
try {
  await ready();
  await load();
  const idle = memory();
  await checkEqual();
  const samples: Record<string, number[]> = {};
  for (let round = 0; round < WARMUP + ROUNDS; round++) await time(round, samples);
  const peak = memory();
  const rows = PAGES.map(({ name }) => ({
    page: name,
    wasm: median(samples[`wasm ${name}`]),
    noop: median(samples[`noop ${name}`]),
  }));
  say(`\n${ROUNDS} rounds after ${WARMUP} warm-up, median ms per request (workerd)\n`);
  say("| page | wasm | request alone |");
  say("| --- | ---: | ---: |");
  for (const r of rows) say(`| ${r.page} | ${r.wasm.toFixed(1)} | ${r.noop.toFixed(1)} |`);
  say(`\nworkerd RSS / peak: after load ${mb(idle)}, after the rounds ${mb(peak)}`);

  const out = join(web, "../../bench/perf-results");
  mkdirSync(out, { recursive: true });
  const file = join(out, `diff-wasm-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ rounds: ROUNDS, rows, idle, peak, samples }, null, 2)}\n`,
  );
  say(`\nsamples: ${file}`);
} finally {
  child.kill();
}
