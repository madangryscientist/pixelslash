/**
 * Argos's own calibration cases (ob 1477), run through both tools without copying them here: they
 * stay inside the argos-bench image, are streamed to a temp dir for the run, and are not kept.
 * The expected verdicts are the ones their own test table asserts for `diffImages` at the threshold
 * listed; they are facts about their cases, not their code.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argosHost, argosKey, runArgos } from "./argos.ts";
import { runPixelslash } from "./pixelslash.ts";
import type { CorpusCase } from "./corpus.ts";
import type { ToolResult } from "./types.ts";

const FIXTURES = "/argos/apps/backend/src/screenshot-diff/diff/image/__fixtures__";

export const ARGOS_CASES: Array<{ name: string; threshold: number; expectChanged: boolean }> = [
  { name: "alphaBackground", threshold: 0.5, expectChanged: false },
  { name: "alphaSmallGraph", threshold: 0.2, expectChanged: true },
  { name: "big-images", threshold: 0.5, expectChanged: true },
  { name: "border", threshold: 0.5, expectChanged: false },
  { name: "boxShadow", threshold: 0.5, expectChanged: false },
  { name: "fontAliasing", threshold: 0.5, expectChanged: false },
  { name: "imageCompression1", threshold: 0.5, expectChanged: false },
  { name: "imageCompression2", threshold: 0.5, expectChanged: false },
  { name: "imageCompression3", threshold: 0.5, expectChanged: false },
  { name: "imageCompression4", threshold: 0.5, expectChanged: false },
  { name: "imageCompression5", threshold: 0.5, expectChanged: false },
  { name: "imageCompression6", threshold: 0.5, expectChanged: false },
  { name: "imageCompression7", threshold: 0.5, expectChanged: false },
  { name: "simple", threshold: 0.5, expectChanged: true },
  { name: "tableAlpha", threshold: 0.5, expectChanged: true },
  { name: "minorChange1", threshold: 0.5, expectChanged: true },
  { name: "minorChange2", threshold: 0.5, expectChanged: false },
  { name: "minorChange3", threshold: 0, expectChanged: true },
  { name: "different-dimensions", threshold: 0, expectChanged: true },
];

export type CalibrationRow = {
  name: string;
  threshold: number;
  expectChanged: boolean;
  argos: ToolResult;
  pixelslash: ToolResult;
};

async function sh(script: string): Promise<void> {
  const proc = Bun.spawn(["bash", "-o", "pipefail", "-c", script], { stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${script}\n${stderr.trim()}`);
}

type ArgosCase = (typeof ARGOS_CASES)[number];

/** Pairs of one threshold group, laid out the way run-pairs.sh wants them. */
function stage(group: ArgosCase[], raw: string, pairs: string): CorpusCase[] {
  for (const c of group) {
    mkdirSync(join(pairs, c.name), { recursive: true });
    copyFileSync(join(raw, c.name, "base.png"), join(pairs, c.name, "base.png"));
    copyFileSync(join(raw, c.name, "compare.png"), join(pairs, c.name, "head.png"));
  }
  return group.map((c) => ({
    name: c.name,
    dir: join(pairs, c.name),
    label: c.expectChanged ? "real" : "noise",
    kind: "argos",
    page: "argos",
    width: 0,
    height: 0,
  }));
}

async function runGroup(group: ArgosCase[], raw: string, work: string): Promise<CalibrationRow[]> {
  const threshold = group[0]?.threshold ?? 0.5;
  const pairs = join(work, `pairs-${threshold}`);
  const cases = stage(group, raw, pairs);
  const argos = await runArgos(pairs, join(work, `out-${threshold}`), threshold);
  const ps = runPixelslash(cases);
  return group.map((c) => {
    const a = argos.results.get(c.name);
    const p = ps.get(c.name);
    if (!a || !p) throw new Error(`no result for calibration case ${c.name}`);
    return { ...c, argos: a, pixelslash: { ...p, diffPng: null } };
  });
}

export async function runCalibration(): Promise<CalibrationRow[]> {
  const work = mkdtempSync(join(tmpdir(), "pixelslash-bench-argos-"));
  try {
    const raw = join(work, "raw");
    mkdirSync(raw);
    await sh(
      `ssh -o BatchMode=yes -i '${argosKey()}' '${argosHost()}' ` +
        `"docker run --rm --network none --entrypoint tar argos-bench -C ${FIXTURES} -cf - ." | tar -C '${raw}' -xf -`,
    );
    const rows: CalibrationRow[] = [];
    for (const threshold of new Set(ARGOS_CASES.map((c) => c.threshold))) {
      const group = ARGOS_CASES.filter((c) => c.threshold === threshold);
      rows.push(...(await runGroup(group, raw, work)));
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
