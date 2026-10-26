/**
 * PS-214's measurement, not a test: an upload burst of N shots against a LAN self-host (the CT),
 * with the server's memory sampled on the CT and split by phase and by process. Not in the gate;
 * `bun perf/rss-burst.ts --shots 50` from `apps/web`, see perf/README.md.
 *
 * It replays what the CLI sends (`packages/engine/src/upload.ts`): a main build (open, PUT every
 * shot four at a time, finalise), then a branch build of changed shots that the server diffs in
 * its finalise, finalised again until nothing is left unmeasured. `perf/rss-sampler.py` runs on
 * the CT over ssh and prints the resident memory of workerd, `vite preview` (or, since PS-220,
 * `deploy/lan/serve.ts`) and the diff sidecar.
 *
 * `--local 1` (PS-220) runs the sampler on this machine instead, against two `systemd-run --user`
 * units (`--web-unit`, `--diff-unit`; their cgroups sit under `--cg`), and restarts them with
 * `systemctl --user`. That is how the desktop A/B of `vite preview` against `serve.ts` is taken:
 * `--server` and `PIXELSLASH_TOKEN` name a local review app, `--org` a local org. perf/README.md.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { form, type Shot, shots } from "./corpus";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2)
  args.set((process.argv[i] ?? "").replace(/^--/, ""), process.argv[i + 1] ?? "");
const opt = (name: string, fallback: string) => args.get(name) ?? fallback;

const COUNT = Number(opt("shots", "50"));
const SERVER = opt("server", "http://192.168.0.34:3000").replace(/\/+$/, "");
const CONCURRENCY = Number(opt("concurrency", "4")); // the CLI's
const MIX = opt("mix", "mixed"); // "mixed", or "WxH" for one size
const SETTLE_S = [10, 60, 180];
const OUT = opt("out", "");
const SSH = opt("ssh", "ssh -i ~/.ssh/id_ed25519_mac root@192.168.0.20");
const CT = opt("ct", "135");
/** PS-220: sample two local `systemd-run --user` units, not the CT's. */
const LOCAL = opt("local", "0") === "1";
const WEB_UNIT = opt("web-unit", "pixelslash-web.service");
const DIFF_UNIT = opt("diff-unit", "pixelslash-diff.service");
const CG = opt("cg", "/sys/fs/cgroup/system.slice/");
/** The org the run's throwaway project goes in (a personal token that belongs to several needs one). */
const ORG = opt("org", "pixelslash");
/** Restart pixelslash-web and pixelslash-diff first, so the run starts from a cold unit. */
const RESTART = opt("restart", "1") === "1";
function credentials(): { servers?: Record<string, { token: string }> } {
  return JSON.parse(readFileSync(`${homedir()}/.config/pixelslash/credentials.json`, "utf8"));
}
/** Token file or `credentials.json` entry; a personal token, since the run makes its own project. */
const TOKEN = process.env["PIXELSLASH_TOKEN"] ?? credentials().servers?.[SERVER]?.token ?? "";
if (!TOKEN) throw new Error(`no token for ${SERVER}: set PIXELSLASH_TOKEN`);

type Sample = Record<string, number> & { t: number };
/** The sampler's answer to a `mark`: the phase's VmHWM per class, `<class>_hwm`. */
type Mark = { mark: string; t: number; hwm: Record<string, number> };
const samples: Sample[] = [];
const marks: Mark[] = [];

const CLASSES = ["workerd", "vite", "host", "sidecar"] as const;

// ---- the sampler on the CT -----------------------------------------------------------------

const code = readFileSync(new URL("./rss-sampler.py", import.meta.url), "utf8");
const b64 = Buffer.from(code).toString("base64");
const [sshBin = "ssh", ...sshArgs] = SSH.replace("~", homedir()).split(" ");
const sampler = Bun.spawn(
  LOCAL
    ? ["python3", "-u", "-c", code]
    : [
        sshBin,
        ...sshArgs,
        `pct exec ${CT} -- python3 -u -c "import base64;exec(base64.b64decode('${b64}'))"`,
      ],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, CG, WEB_UNIT, DIFF_UNIT },
  },
);
/** One line of the sampler's output: a sample, or the answer to a `mark`. */
function take(line: string): void {
  let row: Record<string, number | string>;
  try {
    row = JSON.parse(line);
  } catch {
    return; // A partial line at the end of the stream.
  }
  const numbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(row))
    if (typeof value === "number") numbers[key] = value;
  // The CT's clock is not ours: stamp each line with its arrival here (a LAN hop).
  if ("mark" in row) marks.push({ mark: String(row["mark"]), t: Date.now(), hwm: numbers });
  else samples.push({ ...numbers, t: Date.now() });
}
void (async () => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of sampler.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
})();

/** Close the phase that began at the last mark; resolves with its peak (VmHWM since the reset). */
async function mark(name: string): Promise<void> {
  const before = marks.length;
  const asked = Date.now();
  await sampler.stdin.write(`mark ${name.replaceAll(" ", "_")}\n`);
  await sampler.stdin.flush();
  for (let i = 0; i < 600 && marks.length === before; i++) await Bun.sleep(50);
  if (marks.length === before)
    throw new Error(
      `the sampler did not answer mark ${name} (${samples.length} samples, last ${Date.now() - (samples.at(-1)?.t ?? 0)} ms ago)`,
    );
  process.stderr.write(`mark ${name}: answered after ${Date.now() - asked} ms\n`);
}

async function ct(command: string): Promise<string> {
  if (LOCAL) {
    const run = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
    return await new Response(run.stdout).text();
  }
  const run = Bun.spawn(
    [sshBin, ...sshArgs, `pct exec ${CT} -- bash -c ${JSON.stringify(command)}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  return await new Response(run.stdout).text();
}

// ---- the burst -----------------------------------------------------------------------------

const headers = { authorization: `Bearer ${TOKEN}` };
const json = { ...headers, "content-type": "application/json" };

const hex = () => randomBytes(20).toString("hex");

async function must(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
  return res;
}

async function openBuild(projectId: string, body: object): Promise<string> {
  const res = await fetch(`${SERVER}/api/v1/builds`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ ...body, projectId }),
  });
  const opened: { id: string } = await (await must(res, "open build")).json();
  return opened.id;
}

async function putAll(id: string, list: Shot[]): Promise<void> {
  const queue = [...list];
  const worker = async () => {
    for (let shot = queue.shift(); shot; shot = queue.shift()) {
      const res = await fetch(`${SERVER}/api/v1/builds/${id}/snapshots`, {
        method: "PUT",
        headers,
        body: form(shot),
      });
      await must(res, `PUT ${shot.name}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function finalise(id: string): Promise<{ status: string; unmeasured?: number }> {
  const res = await fetch(`${SERVER}/api/v1/builds/${id}/finalize`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ snapshots: COUNT }),
  });
  const done: { status: string; unmeasured?: number } = await (await must(res, "finalize")).json();
  return done;
}

/** Finalise until the server has measured every shot, as the CLI does after a budget stop. */
async function finaliseUntilMeasured(id: string): Promise<{ rounds: number; status: string }> {
  for (let rounds = 1; rounds <= COUNT; rounds++) {
    const { status, unmeasured } = await finalise(id);
    if (status !== "errored" || !unmeasured) return { rounds, status };
  }
  throw new Error(`build ${id} still has unmeasured shots after ${COUNT} finalises`);
}

/** GET / once a second, as the e2e burst does: a stalled Worker fails the probe (-1). */
function probeHome() {
  const times: Promise<number>[] = [];
  const timer = setInterval(() => {
    const t = Date.now();
    times.push(
      fetch(`${SERVER}/`, { signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          await res.arrayBuffer();
          return res.ok ? Date.now() - t : -1;
        })
        .catch(() => -1),
    );
  }, 1000);
  return () => {
    clearInterval(timer);
    return Promise.all(times);
  };
}

async function waitUp(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${SERVER}/`, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch {
      // Still starting.
    }
    await Bun.sleep(1000);
  }
  throw new Error(`${SERVER} did not come up`);
}

// ---- phases and the report -----------------------------------------------------------------

type Phase = {
  name: string;
  from: number;
  to: number;
  seconds: number;
  extra?: string | undefined;
};
const phases: Phase[] = [];
let phaseStart = Date.now();

async function endPhase(name: string, extra?: string): Promise<void> {
  await mark(name);
  const to = Date.now();
  phases.push({ name, from: phaseStart, to, seconds: (to - phaseStart) / 1000, extra });
  phaseStart = to;
}

const peakOf = (key: string, from: number, to: number) =>
  Math.max(0, ...samples.filter((s) => s.t >= from && s.t <= to).map((s) => s[key] ?? 0));
const lastOf = (key: string, at: number) => samples.filter((s) => s.t <= at).at(-1)?.[key] ?? 0;

if (RESTART) {
  await ct(
    LOCAL
      ? `systemctl --user restart ${DIFF_UNIT} ${WEB_UNIT}`
      : "systemctl restart pixelslash-diff pixelslash-web",
  );
  await Bun.sleep(2000);
}
await waitUp();
await fetch(`${SERVER}/`).then((r) => r.arrayBuffer()); // the first request loads the Worker
await Bun.sleep(5000);

const project: { id: string } = await (
  await must(
    await fetch(`${SERVER}/api/v1/projects`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ name: `ps-214-rss-${COUNT}-${Date.now().toString(36)}`, org: ORG }),
    }),
    "create project",
  )
).json();
const projectId = project.id;

const main = shots(MIX, COUNT, 200);
const branch = shots(MIX, COUNT, 260);
const bytes = (list: Shot[]) => list.reduce((n, s) => n + s.png.length, 0);

await Bun.sleep(1000);
await mark("start"); // resets VmHWM: idle is what the unit holds now
phaseStart = Date.now();
const idle = Object.fromEntries(CLASSES.map((c) => [c, lastOf(c, Date.now())]));
const stopProbe = probeHome();
const shaMain = hex();

const mainId = await openBuild(projectId, { branch: "main", commitSha: shaMain });
await putAll(mainId, main);
await endPhase("main PUTs");
const mainFinal = await finalise(mainId);
await endPhase("main finalize", mainFinal.status);

await Bun.sleep(1100);
phaseStart = Date.now();
const branchId = await openBuild(projectId, {
  branch: "work",
  commitSha: hex(),
  mergeBaseSha: shaMain,
  ancestorShas: [shaMain],
});
await putAll(branchId, branch);
await endPhase("branch PUTs");
const { rounds, status } = await finaliseUntilMeasured(branchId);
await endPhase("branch finalize (diff)", `${rounds} finalizes, ${status}`);

const homeTimes = await stopProbe();
const diffEnd = Date.now();
for (const s of SETTLE_S) {
  await Bun.sleep(diffEnd + s * 1000 - Date.now());
  await endPhase(`settled +${s}s`);
}
sampler.kill();

const result = {
  commit: opt("commit", ""),
  server: SERVER,
  shots: COUNT,
  mix: MIX,
  concurrency: CONCURRENCY,
  uploadMB: { main: bytes(main) / 1e6, branch: bytes(branch) / 1e6 },
  cold: RESTART,
  idle,
  phases: phases.map((p) => ({
    phase: p.name,
    seconds: p.seconds,
    note: p.extra,
    peakMB: Object.fromEntries(CLASSES.map((c) => [c, peakOf(c, p.from, p.to)])),
    hwmMB: Object.fromEntries(
      CLASSES.map((c) => [
        c,
        marks.find((m) => m.mark === p.name.replaceAll(" ", "_"))?.hwm[`${c}_hwm`] ?? 0,
      ]),
    ),
    endMB: Object.fromEntries(CLASSES.map((c) => [c, lastOf(c, p.to)])),
    webUnitPeakMB: peakOf("web_cur", p.from, p.to),
    webUnitSwapPeakMB: peakOf("web_swap", p.from, p.to),
    webUnitAnonPeakMB: peakOf("web_anon", p.from, p.to),
    webUnitFilePeakMB: peakOf("web_file", p.from, p.to),
    webUnitEndMB: lastOf("web_cur", p.to),
    webHighEvents: lastOf("web_high_events", p.to),
    diffUnitPeakMB: peakOf("diff_cur", p.from, p.to),
  })),
  probes: {
    count: homeTimes.length,
    failed: homeTimes.filter((ms) => ms < 0).length,
    slowestMs: Math.max(0, ...homeTimes),
  },
};
const text = JSON.stringify(result, null, 2);
if (OUT) writeFileSync(OUT, text + "\n");
process.stdout.write(text + "\n");
