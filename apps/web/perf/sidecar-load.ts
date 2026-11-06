/**
 * PS-325's measurement, not a test: N background uploaders of tall shots and one foreground build
 * against a local production server with the diff sidecar. On demand, on a development machine, never
 * against the review server; perf/README.md says how.
 *
 *   CLOUDFLARE_ENV=e2e bun run build
 *   bun perf/sidecar-load.ts --uploaders 3 --fresh 1 --out run.json
 *
 * Every pixel changes by default: that is a diff's slowest case, ~3.9 s on this size, and the load
 * that shows the failure. `--change small` diffs in ~0.3 s and does not show it.
 *
 * The server is `deploy/ssh/serve.ts` and `deploy/ssh/diff-sidecar.ts`, as `rss-burst.ts --local 1`
 * runs them: two `systemd-run --user` units, here under the limits the shipped units have. Every
 * client speaks the CLI's protocol (`packages/engine/src/upload.ts`): open, PUT four at a time,
 * finalise, and finalise again only while the count left falls. A background uploader repeats that
 * until the foreground has ended and then finishes the build it is on, so the load lasts the whole
 * run and no build is abandoned. What is reported comes from the server's own D1 file and the units'
 * journals, not from what the clients think happened.
 */
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shots } from "./corpus";
import { Client, type Finalise } from "./sidecar-load-client";
import {
  BG_SHOTS,
  CHANGE,
  CONCURRENCY,
  DIFF_UNIT,
  FRESH,
  OUT,
  PORT,
  type Project,
  SHOTS,
  SIDECAR_PORT,
  SIZE,
  STATE,
  TERMINAL_MISS_MS,
  UPLOADERS,
  WEB,
  WEB_UNIT,
  hex,
  journal,
  openStateDb,
  portBusy,
  probeHome,
  sampleMemory,
  say,
  seed,
  startUnit,
  stopUnits,
  storedBuild,
  unitFacts,
  waitUp,
} from "./sidecar-load-server";

const project = (name: string): Project => ({
  id: `load-${name}`,
  token: `psci_${randomBytes(24).toString("hex")}`,
});

/** A fresh state, the seeded projects and both units. Returns what the journals are read from. */
async function startServer(projects: Project[]): Promise<string> {
  if (!existsSync(join(WEB, "dist/server/wrangler.json")))
    throw new Error("no build: run CLOUDFLARE_ENV=e2e bun run build in apps/web first");
  stopUnits();
  if (existsSync(STATE)) {
    if (!FRESH)
      throw new Error(`${STATE} exists: pass --fresh 1 to delete it, or move it out of the way`);
    rmSync(STATE, { recursive: true, force: true });
  }
  for (const port of [PORT, SIDECAR_PORT])
    if (await portBusy(port)) throw new Error(`port ${port} is already in use`);
  seed(projects);
  const since = `@${Math.floor(Date.now() / 1000) - 1}`; // journalctl reads a bare date as local time
  startUnit(DIFF_UNIT, "deploy/ssh/diff-sidecar.ts", "1000M", []);
  startUnit(WEB_UNIT, "deploy/ssh/serve.ts", "2500M", ["HOST=127.0.0.1", `PORT=${PORT}`]);
  await waitUp();
  return since;
}

type Load = {
  ids: Set<string>;
  clients: Client[];
  builds: { uploader: number; rounds: Finalise[]; ms: number }[];
  foregroundDone: boolean;
};

function tracked(load: Load, p: Project): Client {
  const client = new Client(p);
  load.clients.push(client);
  return client;
}

const branchOf = (branch: string, mainSha: string) => ({
  branch,
  commitSha: hex(),
  mergeBaseSha: mainSha,
  ancestorShas: [mainSha],
});

/** A main build, measured against nothing: the baseline a branch build is compared with. */
async function baseline(client: Client, list: ReturnType<typeof shots>, load: Load) {
  const sha = hex();
  const id = await client.open({ branch: "main", commitSha: sha });
  load.ids.add(id);
  await client.putAll(id, list);
  await client.finalise(id, list.length);
  return sha;
}

/** Branch builds until the foreground has ended; the one in hand still finishes. */
async function uploaderLoop(
  i: number,
  client: Client,
  sha: string,
  work: { load: Load; list: ReturnType<typeof shots> },
) {
  const { load, list } = work;
  while (!load.foregroundDone) {
    const started = Date.now();
    const id = await client.open(branchOf(`work-${i}`, sha));
    load.ids.add(id);
    await client.putAll(id, list);
    const rounds = await client.finalise(id, list.length);
    load.builds.push({ uploader: i, rounds, ms: Date.now() - started });
  }
}

const tally = (list: string[]) =>
  list.reduce<Record<string, number>>((all, s) => {
    all[s] = (all[s] ?? 0) + 1;
    return all;
  }, {});

function homeFacts(home: number[]) {
  const answered = home.filter((ms) => ms >= 0);
  return {
    count: home.length,
    failed: home.length - answered.length,
    over5s: answered.filter((ms) => ms > TERMINAL_MISS_MS).length,
    slowestMs: Math.max(0, ...answered),
  };
}

function sidecarFacts(log: string) {
  const diffMs = [...log.matchAll(/^diff \d+x\d+ \d+ changed (\d+) ms$/gm)]
    .map((m) => Number(m[1]))
    .toSorted((a, b) => a - b);
  return {
    diffs: diffMs.length,
    medianMs: diffMs[Math.floor(diffMs.length / 2)] ?? 0,
    slowestMs: diffMs.at(-1) ?? 0,
    failed: [...log.matchAll(/^failed: .*$/gm)].length,
  };
}

/** What the server stored for every build, not what its client was told. */
function buildFacts(ids: Set<string>) {
  const db = openStateDb();
  const stored = [...ids].map((id) => storedBuild(db, id));
  return {
    total: stored.length,
    byStatus: tally(stored.map((b) => b.status)),
    inFlight: stored.filter((b) => b.status === "uploading" || b.status === "processing").length,
  };
}

type Foreground = { id: string; rounds: Finalise[]; putMs: number; wallMs: number };

/** Read the logs and limits while the units are still there, then stop them and read the store. */
function report(input: {
  load: Load;
  foreground: Foreground;
  settled: PromiseSettledResult<void>[];
  home: number[];
  since: string;
  totalMs: number;
}) {
  const { load, foreground: fg } = input;
  const webLog = journal(WEB_UNIT, input.since);
  const diffLog = journal(DIFF_UNIT, input.since);
  const units = { web: unitFacts(WEB_UNIT), diff: unitFacts(DIFF_UNIT) };
  stopUnits();
  return {
    uploaders: UPLOADERS,
    size: SIZE,
    change: CHANGE,
    concurrency: CONCURRENCY,
    bgShots: BG_SHOTS,
    foreground: {
      ...storedBuild(openStateDb(), fg.id),
      finalises: fg.rounds.length,
      putSeconds: fg.putMs / 1000,
      wallSeconds: fg.wallMs / 1000,
      rounds: fg.rounds,
    },
    background: {
      builds: load.builds.length,
      outcomes: tally(load.builds.map((b) => b.rounds.at(-1)?.status ?? "")),
      finalisesPerBuild: load.builds.map((b) => b.rounds.length),
      failures: input.settled.flatMap((s) => (s.status === "rejected" ? [String(s.reason)] : [])),
    },
    builds: buildFacts(load.ids),
    home: homeFacts(input.home),
    sidecar: sidecarFacts(diffLog),
    fellBack: [...webLog.matchAll(/server diff: in-process.*$/gm)].map((m) => m[0]),
    retries: load.clients.reduce((n, c) => n + c.tally.retries, 0),
    units,
    totalSeconds: input.totalMs / 1000,
  };
}

async function main() {
  const fgProject = project("fg");
  const bgProjects = Array.from({ length: UPLOADERS }, (_, i) => project(`bg${i}`));
  const since = await startServer([fgProject, ...bgProjects]);

  // Two pools so main and branch differ, and the hash shortcut does not fire.
  say(`generating ${SIZE} shots`);
  const fgMain = shots(SIZE, SHOTS, 300);
  const fgBranch = shots(SIZE, SHOTS, 900, CHANGE === "all" ? 10 : 0);
  const bgMain = fgMain.slice(0, BG_SHOTS);
  const bgBranch = fgBranch.slice(0, BG_SHOTS);
  say(`${UPLOADERS} uploaders, foreground ${SHOTS} shots`);

  const load: Load = { ids: new Set(), clients: [], builds: [], foregroundDone: false };
  const bgClients = bgProjects.map((p) => tracked(load, p));
  const bgBaselines = bgClients.map((client) => baseline(client, bgMain, load));
  const background = bgClients.map(async (client, i) =>
    uploaderLoop(i, client, await (bgBaselines[i] ?? ""), { load, list: bgBranch }),
  );

  // The foreground's baseline, then its branch build once every uploader is on its branch builds.
  const fg = tracked(load, fgProject);
  const fgSha = await baseline(fg, fgMain, load);
  await Promise.all(bgBaselines);

  const stopProbe = probeHome();
  const memory = setInterval(() => {
    sampleMemory(WEB_UNIT);
    sampleMemory(DIFF_UNIT);
  }, 1000);
  say("foreground branch build opens");
  const started = Date.now();
  const id = await fg.open(branchOf("work", fgSha));
  load.ids.add(id);
  await fg.putAll(id, fgBranch);
  const putMs = Date.now() - started;
  const rounds = await fg.finalise(id, SHOTS);
  const foreground = { id, rounds, putMs, wallMs: Date.now() - started };
  load.foregroundDone = true;
  say(`foreground ended ${rounds.at(-1)?.status} in ${(foreground.wallMs / 1000).toFixed(1)} s`);

  const settled = await Promise.allSettled(background);
  const home = await stopProbe();
  clearInterval(memory);
  const result = report({ load, foreground, settled, home, since, totalMs: Date.now() - started });
  const text = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, `${text}\n`);
  process.stdout.write(`${text}\n`);
  say(
    `RESULT ${UPLOADERS} uploaders: foreground ${result.foreground.status}, ${result.foreground.measured} of ${result.foreground.shots} measured, ` +
      `${result.foreground.errored} errored, ${rounds.length} finalises, ${(foreground.wallMs / 1000).toFixed(1)} s; ` +
      `${result.builds.inFlight} builds in flight of ${result.builds.total}; slowest GET / ${result.home.slowestMs} ms`,
  );
}

try {
  await main();
} finally {
  stopUnits();
}
