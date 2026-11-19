/**
 * PS-464's measurement, not a test: tall uploads against one local web unit shaped like the CT's
 * `pixelslash-web` (`MemoryMax=4000M`, `MemorySwapMax=0`, no `MemoryHigh`, `OOMPolicy=stop`,
 * `Restart=on-failure`), with every server diff in workerd. On demand, on a development machine,
 * never against the review server; perf/README.md says how.
 *
 *   PIXELSLASH_E2E=1 CLOUDFLARE_ENV=e2e PIXELSLASH_E2E_STUB_PORT=9 PIXELSLASH_E2E_DIFF_LIMIT_MPX= bun run build
 *   bun perf/web-burst.ts --size 1280x16800 --uploaders 3 --fresh 1 --out run.json
 *
 * The build bakes the pixel limit in (`PIXELSLASH_E2E_DIFF_LIMIT_MPX`, empty for none; unset keeps
 * `wrangler.jsonc`'s); the run reads it back from `dist/server/wrangler.json` and reports it. Every
 * pixel changes by default, a diff's slowest and largest case. `--uploaders` clients each upload a
 * baseline and then `--builds` branch builds of `--shots` shots, finalising as the CLI does.
 *
 * Throughout, `GET /` is asked once a second with the watchdog's 10 s wait, and each answer is
 * recorded with the unit's state at the time: the claim under test is that port 3000 never stops
 * answering while the unit reads `active`; an OOM kill and a restart are allowed. Memory is the
 * cgroup's (`MemoryPeak`, anon and page cache sampled each second), and what each build ended as
 * is read from the server's own D1 file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shots } from "./corpus";
import {
  Client,
  type Finalise,
  WEB,
  type WebUnit,
  hex,
  memoryNow,
  openStateDb,
  project,
  say,
  startWebUnit,
  stopUnit,
  storedBuild,
  unitFacts,
  unitShow,
} from "./web-unit";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set((process.argv[i] ?? "").replace(/^--/, ""), process.argv[i + 1] ?? "");
const opt = (name: string, fallback: string) => args.get(name) ?? fallback;

const SIZE = opt("size", "1280x16800");
const UPLOADERS = Number(opt("uploaders", "3"));
const SHOTS = Number(opt("shots", "7"));
const BUILDS = Number(opt("builds", "2"));
const MAX = opt("max", "4000M");
const PORT = Number(opt("port", "3464"));
const SETTLE_S = Number(opt("settle", "30"));
const OUT = opt("out", "");
const FRESH = opt("fresh", "0") === "1";

const WEB_UNIT: WebUnit = {
  unit: "ps-web-burst",
  port: PORT,
  server: `http://127.0.0.1:${PORT}`,
  limits: [`MemoryMax=${MAX}`, "MemorySwapMax=0"],
};

type Probe = { at: number; ms: number; active: string };

/** `GET /` once a second; -1 when it did not answer in the watchdog's 10 s. */
function probeHome() {
  const probes: Promise<Probe>[] = [];
  const timer = setInterval(() => {
    const at = Date.now();
    probes.push(
      fetch(`${WEB_UNIT.server}/`, { signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          await res.arrayBuffer();
          return res.ok ? Date.now() - at : -1;
        })
        .catch(() => -1)
        .then((ms) => ({ at, ms, active: unitShow(WEB_UNIT.unit, "ActiveState") })),
    );
  }, 1000);
  return () => {
    clearInterval(timer);
    return Promise.all(probes);
  };
}

function probeFacts(probes: Probe[]) {
  const answered = probes.filter((p) => p.ms >= 0).map((p) => p.ms);
  let run = 0;
  let longest = 0;
  for (const p of probes) {
    run = p.ms < 0 && p.active === "active" ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    count: probes.length,
    failed: probes.length - answered.length,
    silentWhileActive: probes.filter((p) => p.ms < 0 && p.active === "active").length,
    longestSilentWhileActive: longest,
    slowestMs: Math.max(0, ...answered),
  };
}

function bakedLimit(): string {
  const config = JSON.parse(readFileSync(join(WEB, "dist/server/wrangler.json"), "utf8"));
  return String(config.vars?.["DIFF_LIMIT_MPX"] ?? "");
}

async function burst() {
  const projects = Array.from({ length: UPLOADERS }, (_, i) => project(`burst${i}`));
  await startWebUnit(WEB_UNIT, projects, { fresh: FRESH });
  say(`${WEB_UNIT.unit} up on ${WEB_UNIT.server}: MemoryMax=${MAX}, limit "${bakedLimit()}" Mpx`);
  say(`generating ${SHOTS} shots at ${SIZE}, every pixel changed`);
  const baseline = shots(SIZE, SHOTS, 300);
  const branch = shots(SIZE, SHOTS, 900, 10);

  const memory: ReturnType<typeof memoryNow>[] = [];
  const sampler = setInterval(() => memory.push(memoryNow(WEB_UNIT.unit)), 1000);
  const idle = memoryNow(WEB_UNIT.unit);
  const stopProbe = probeHome();
  const ids: string[] = [];
  const rounds: Finalise[][] = [];
  const started = Date.now();
  const settled = await Promise.allSettled(
    projects.map(async (p, i) => {
      const client = new Client(WEB_UNIT.server, p);
      const sha = hex();
      const mainId = await client.open({ branch: "main", commitSha: sha });
      ids.push(mainId);
      await client.putAll(mainId, baseline);
      await client.finalise(mainId, SHOTS);
      for (let b = 0; b < BUILDS; b++) {
        const id = await client.open({
          branch: `work-${i}`,
          commitSha: hex(),
          mergeBaseSha: sha,
          ancestorShas: [sha],
        });
        ids.push(id);
        await client.putAll(id, branch);
        rounds.push(await client.finalise(id, SHOTS));
        say(`uploader ${i} build ${b + 1}: ${rounds.at(-1)?.at(-1)?.status}`);
      }
    }),
  );
  const burstSeconds = (Date.now() - started) / 1000;
  say(`burst done in ${burstSeconds.toFixed(0)} s; settling ${SETTLE_S} s`);
  await Bun.sleep(SETTLE_S * 1000);
  clearInterval(sampler);
  const probes = await stopProbe();
  const settledMemory = memoryNow(WEB_UNIT.unit);
  const unit = unitFacts(WEB_UNIT.unit);
  stopUnit(WEB_UNIT.unit);

  const db = openStateDb();
  const stored = ids.map((id) => storedBuild(db, id));
  const result = {
    size: SIZE,
    limitMpx: bakedLimit(),
    memoryMax: MAX,
    uploaders: UPLOADERS,
    shots: SHOTS,
    buildsEach: BUILDS,
    burstSeconds,
    idle,
    peak: {
      cgroupMB: unit.peakMB,
      anonMB: Math.max(0, ...memory.map((m) => m.anonMB)),
      fileMB: Math.max(0, ...memory.map((m) => m.fileMB)),
    },
    settled: settledMemory,
    unit,
    probes: probeFacts(probes),
    builds: stored,
    finalises: rounds.map((r) => r.length),
    failures: settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : [])),
  };
  const text = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, `${text}\n`);
  process.stdout.write(`${text}\n`);
  say(
    `RESULT ${SIZE} limit "${result.limitMpx}": peak ${unit.peakMB} MiB (anon ${result.peak.anonMB}), ` +
      `settled ${settledMemory.currentMB} MiB (anon ${settledMemory.anonMB}); ` +
      `restarts ${unit.restarts}, oom kills ${unit.oomKills}; ` +
      `GET / silent while active ${result.probes.silentWhileActive} of ${result.probes.count}`,
  );
}

try {
  await burst();
} finally {
  stopUnit(WEB_UNIT.unit);
}
