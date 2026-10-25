/**
 * PS-204's timing run: the server diff with pngjs against the WebAssembly diff, in workerd, and
 * (PS-205) the WebAssembly diff with pngjs's overlay encode against its own. On demand only, never
 * in the gate:
 *
 *   cd apps/web && bun perf/diff-wasm/run.ts [--rounds 15]
 *
 * It builds `worker.ts` with the Cloudflare Vite plugin and serves it twice with `vite preview`
 * (each its own workerd): one for pngjs, the overlay encode and its deflate, one for wasm with
 * either encode, so each process's peak RSS (VmHWM) is one engine's. Every pair is checked equal
 * across the three diffs first. Then
 * the rounds interleave the implementations; each request is one diff, timed from here, and the
 * median of the rounds is reported. Raw samples go to the gitignored `bench/perf-results/`.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIFF_SIZES, page } from "../../../../bench/src/perf/fixtures.ts";

const here = import.meta.dirname;
const web = join(here, "../..");
const config = join(here, "vite.config.ts");
const MARKER = "PIXELSLASH_DIFF_WASM_BENCH";

const flag = (name: string, fallback: number) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const ROUNDS = flag("--rounds", 15);
const WARMUP = 3;

/** The pages of the 2026-10-25 dedicated run (PS-168), and its seeds (`writeFixtures`). */
const PAGES = Object.entries(DIFF_SIZES).map(([name, { width, height }], i) => ({
  name: name.replace("diff-", ""),
  main: page(width, height, 100 + i, false),
  branch: page(width, height, 100 + i, true),
}));

type Server = { name: string; port: number; child: ChildProcess };

function serve(name: string, port: number): Server {
  const child = spawn(
    "bunx",
    [
      "vite",
      "preview",
      "--config",
      config,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: web, env: { ...process.env, [MARKER]: String(port) }, stdio: "inherit" },
  );
  return { name, port, child };
}

async function ready(server: Server): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(`http://127.0.0.1:${server.port}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`${server.name} did not start on :${server.port}`);
}

/** VmRSS and VmHWM in MB of the workerd that serves `port`. */
function memory(port: number): { rss: number; peak: number } {
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${pid}/comm`, "utf8").startsWith("workerd")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`${MARKER}=${port}\0`)) continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN);
      return { rss: kb("VmRSS") / 1024, peak: kb("VmHWM") / 1024 };
    } catch {
      // A process that exited while it was read.
    }
  }
  throw new Error(`no workerd for :${port}`);
}

type Checked = { fellBack: string[] };

async function run(server: Server, impl: string, name: string, check = false): Promise<Checked> {
  const url = `http://127.0.0.1:${server.port}/run?impl=${impl}&page=${name}${check ? "&check" : ""}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${impl} ${name}: ${response.status} ${await response.text()}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new Error(`${impl} ${name}: not an object`);
  const fellBack = "fellBack" in body && Array.isArray(body.fellBack) ? body.fellBack : [];
  return { ...body, fellBack: fellBack.map(String) };
}

async function timed(server: Server, impl: string, name: string): Promise<number> {
  const start = performance.now();
  await run(server, impl, name);
  return performance.now() - start;
}

const median = (samples: number[] = []) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  const [low = NaN, high = NaN] = sorted.slice(mid - (sorted.length % 2 ? 0 : 1), mid + 1);
  return sorted.length % 2 ? low : (low + high) / 2;
};

const say = (line = "") => process.stdout.write(`${line}\n`);
const pct = (now: number, was: number) => `${((now / was - 1) * 100).toFixed(0)}%`;
const mb = (m: { rss: number; peak: number }) => `${m.rss.toFixed(0)} / ${m.peak.toFixed(0)} MB`;

async function load(server: Server): Promise<void> {
  for (const { name, main, branch } of PAGES) {
    const response = await fetch(`http://127.0.0.1:${server.port}/load?page=${name}`, {
      method: "POST",
      headers: { "x-main-length": String(main.length) },
      body: Buffer.concat([main, branch]),
    });
    if (!response.ok) throw new Error(`load ${name}: ${response.status}`);
  }
}

/** The same answer in workerd before any time is taken: every field and the overlay's sha256. */
async function checkEqual(pngjs: Server, wasm: Server): Promise<void> {
  for (const { name } of PAGES) {
    const want = JSON.stringify({ ...(await run(pngjs, "pngjs", name, true)), fellBack: [] });
    for (const impl of ["wasm", "wasm-pngjs"]) {
      const got = await run(wasm, impl, name, true);
      if (got.fellBack.length > 0) throw new Error(`${impl} fell back: ${got.fellBack.join("; ")}`);
      if (JSON.stringify({ ...got, fellBack: [] }) !== want)
        throw new Error(`${name}: ${impl} and pngjs differ in workerd`);
    }
  }
}

/** Every implementation on every page each round, the order reversed on odd rounds. */
async function rounds(plan: [Server, string][]): Promise<Record<string, number[]>> {
  const samples: Record<string, number[]> = {};
  for (let round = 0; round < WARMUP + ROUNDS; round++) {
    const order = round % 2 ? plan.toReversed() : plan;
    const runs = PAGES.flatMap(({ name }) =>
      order.map(([server, impl]) => ({ server, impl, name })),
    );
    for (const { server, impl, name } of runs) {
      const ms = await timed(server, impl, name);
      if (round >= WARMUP) (samples[`${impl} ${name}`] ??= []).push(ms);
    }
  }
  return samples;
}

const build = spawnSync("bunx", ["vite", "build", "--config", config], {
  cwd: web,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("vite build failed");

const pngjs = serve("pngjs", 4191);
const wasm = serve("wasm", 4192);
try {
  await Promise.all([ready(pngjs), ready(wasm)]);
  await load(pngjs);
  await load(wasm);
  const idle = { pngjs: memory(pngjs.port), wasm: memory(wasm.port) };
  await checkEqual(pngjs, wasm);
  const samples = await rounds([
    [pngjs, "pngjs"],
    [wasm, "wasm"],
    [wasm, "wasm-pngjs"],
    [pngjs, "encode"],
    [pngjs, "deflate"],
    [wasm, "noop"],
  ]);
  const peak = { pngjs: memory(pngjs.port), wasm: memory(wasm.port) };

  const rows = PAGES.map(({ name, main, branch }) => {
    const at = (impl: string) => median(samples[`${impl} ${name}`]);
    return {
      page: name,
      bytes: main.length + branch.length,
      pngjs: at("pngjs"),
      wasm: at("wasm"),
      wasmPngjs: at("wasm-pngjs"),
      encode: at("encode"),
      deflate: at("deflate"),
      noop: at("noop"),
    };
  });
  say(`\n${ROUNDS} rounds after ${WARMUP} warm-up, median ms per request (workerd)\n`);
  say(
    "| page | pngjs | wasm, pngjs encode | wasm | change | vs pngjs | pngjs encode | its deflate | request alone |",
  );
  say("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    const ms = [r.pngjs, r.wasmPngjs, r.wasm].map((v) => v.toFixed(1)).join(" | ");
    const parts = [r.encode, r.deflate, r.noop].map((v) => v.toFixed(1)).join(" | ");
    say(`| ${r.page} | ${ms} | ${pct(r.wasm, r.wasmPngjs)} | ${pct(r.wasm, r.pngjs)} | ${parts} |`);
  }
  say(`\nworkerd RSS / peak after load: pngjs ${mb(idle.pngjs)}, wasm ${mb(idle.wasm)}`);
  say(`workerd RSS / peak after the rounds: pngjs ${mb(peak.pngjs)}, wasm ${mb(peak.wasm)}`);

  const out = join(web, "../../bench/perf-results");
  mkdirSync(out, { recursive: true });
  const file = join(out, `diff-wasm-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ rounds: ROUNDS, rows, idle, peak, samples }, null, 2)}\n`,
  );
  say(`\nsamples: ${file}`);
} finally {
  pngjs.child.kill();
  wasm.child.kill();
}
