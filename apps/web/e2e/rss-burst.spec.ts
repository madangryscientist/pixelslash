import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { SHA_MAIN, SHA_WORK, provision, uploadBuild } from "./api-upload";
import { type Block, png } from "./png";
import { SERVER, SERVER_PORT, SIDECAR_PORT } from "./ports";

/**
 * PS-200's measurement, not a test: replays an upload burst of full-page shots (a main build, then
 * a branch build the server diffs in its finalise) and prints workerd's resident memory as it
 * goes. It is skipped unless `PIXELSLASH_RSS_BURST` is set (the shot count, e.g. 50), so the gate
 * never runs it: `PIXELSLASH_RSS_BURST=50 bunx playwright test rss-burst` from `apps/web`.
 * Linux only (/proc).
 *
 * PS-203 added the diff sidecar's RSS and the diff's time. The run diffs in the sidecar, as the LAN
 * does; `PIXELSLASH_E2E_NO_SIDECAR=1` diffs in workerd with pngjs, as Cloudflare does. A finalise
 * stops at the Worker's diff budget, so the branch build is finalised again until nothing is left
 * unmeasured, as the CLI does; `diffSeconds` is the branch upload less the main one (the same PUTs,
 * no diff).
 */

const COUNT = Number(process.env["PIXELSLASH_RSS_BURST"] ?? 0);
const WIDTH = 1280;
const HEIGHT = Number(process.env["PIXELSLASH_RSS_HEIGHT"] ?? 5000);

/** The resident MB of every `comm` process this run started: its env holds `marker`, its argv `arg`. */
function rssMb(comm: string, marker: string, arg = ""): number {
  let kb = 0;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/comm`, "utf8").startsWith(comm)) continue;
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!environ.includes(marker)) continue;
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(arg)) continue;
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return Math.round(kb / 1024);
}

/** Every workerd this run started (they inherit its port from the env). */
const workerdRssMb = () => rssMb("workerd", `PIXELSLASH_E2E_PORT=${SERVER_PORT}`);
/** The run's diff sidecar; 0 when it runs without one. Its argv tells it from the test workers, which inherit the var. */
const sidecarRssMb = () =>
  rssMb("bun", `PIXELSLASH_DIFF_SIDECAR_PORT=${SIDECAR_PORT}`, "diff-sidecar.ts");

/** Finalise again until the server has measured every shot: what the CLI does after a budget stop. */
async function finaliseUntilMeasured(token: string, id: string, count: number): Promise<number> {
  // Each round measures at least one more shot, so `count` rounds are enough; more is a stuck build.
  for (let rounds = 1; rounds <= count; rounds++) {
    const res = await fetch(`${SERVER}/api/v1/builds/${id}/finalize`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ snapshots: count }),
    });
    const { status, unmeasured }: { status: string; unmeasured?: number } = await res.json();
    if (status !== "errored" || !unmeasured) return rounds;
  }
  throw new Error(`build ${id} still has unmeasured shots after ${count} finalises`);
}

function block(n: number, at: number): Block {
  return { x: 40 + n * 90, y: at, w: 60, h: 400, rgb: [220, 30 + n * 20, 30] };
}

/** `COUNT` shots cycling through three busy full-page PNGs, so each upload is MBs, as a real page is. */
function shots(blockAt: number) {
  const variants = [0, 1, 2].map((n) => png(WIDTH, HEIGHT, [block(n, blockAt)], n));
  return Array.from({ length: COUNT }, (_, i) => ({
    name: `page-${i}`,
    png: variants[i % variants.length] ?? Buffer.alloc(0),
  }));
}

test.skip(COUNT === 0, "PS-200 measurement: set PIXELSLASH_RSS_BURST to the shot count");

test(`workerd RSS across a burst of ${COUNT} full-page shots`, async ({ page }) => {
  test.setTimeout(600_000);
  const { token } = await provision(page, "Burst Co", "burst");
  const main = shots(200);
  const branch = shots(260);

  const samples: number[] = [];
  const sidecarSamples: number[] = [];
  const idle = workerdRssMb();
  const sidecarIdle = sidecarRssMb();
  // 0 means no workerd was found in /proc, not a small number: do not print it as a result.
  expect(idle).toBeGreaterThan(0);
  const sampler = setInterval(() => {
    samples.push(workerdRssMb());
    sidecarSamples.push(sidecarRssMb());
  }, 250);
  const t0 = Date.now();
  await uploadBuild(token, { branch: "main", commitSha: SHA_MAIN }, main);
  const mainMs = Date.now() - t0;
  const afterMain = workerdRssMb();
  await page.waitForTimeout(1100);
  const t1 = Date.now();
  const id = await uploadBuild(
    token,
    { branch: "work", commitSha: SHA_WORK, mergeBaseSha: SHA_MAIN, ancestorShas: [SHA_MAIN] },
    branch,
  );
  // The first finalise was uploadBuild's: this one says whether it stopped at the budget.
  const rounds = await finaliseUntilMeasured(token, id, branch.length);
  const branchMs = Date.now() - t1;
  clearInterval(sampler);
  const afterBranch = workerdRssMb();
  await page.waitForTimeout(10_000);
  const settled = workerdRssMb();
  const peak = Math.max(...samples, afterBranch);
  const sidecarPeak = Math.max(0, ...sidecarSamples);
  const sidecarSettled = sidecarRssMb();
  const seconds = Math.round((Date.now() - t0) / 1000);
  process.stdout.write(
    `RSS-BURST shots=${COUNT} ${WIDTH}x${HEIGHT} idle=${idle}MB afterMain=${afterMain}MB ` +
      `peak=${peak}MB afterBranch=${afterBranch}MB settled10s=${settled}MB seconds=${seconds} ` +
      `sidecar idle=${sidecarIdle}MB peak=${sidecarPeak}MB settled10s=${sidecarSettled}MB ` +
      `mainUpload=${(mainMs / 1000).toFixed(1)}s branchUpload=${(branchMs / 1000).toFixed(1)}s ` +
      `diffSeconds=${((branchMs - mainMs) / 1000).toFixed(1)} finalises=${rounds}\n`,
  );
});
