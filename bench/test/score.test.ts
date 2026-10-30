import { describe, expect, test } from "vitest";
import type { CorpusCase } from "../src/corpus.ts";
import { locationDisagreements, scoreTool, verdictDisagreements } from "../src/score.ts";
import type { CaseResult, ToolResult } from "../src/types.ts";

const box = { x: 0, y: 0, w: 10, h: 10 };

function tool(changed: boolean, region = changed ? box : null, ms: number | null = 1): ToolResult {
  return {
    changed,
    regions: region ? [region] : [],
    ms,
    note: "",
    diffPng: null,
    sizeMismatch: false,
  };
}

function row(
  name: string,
  label: CorpusCase["label"],
  kind: string,
  ...tools: [pixelslash: ToolResult, argos: ToolResult | null]
): CaseResult {
  const c: CorpusCase = {
    name,
    dir: "",
    corpus: "main",
    label,
    kind,
    page: "p",
    width: 20,
    height: 20,
  };
  if (label === "real") c.box = box;
  return { case: c, pixelslash: tools[0], argos: tools[1] };
}

const rows: CaseResult[] = [
  row("real-a", "real", "colour", tool(true), tool(false)),
  row("real-b", "real", "text", tool(true, { x: 0, y: 0, w: 10, h: 5 }), tool(true)),
  row("noise-a", "noise", "caret", tool(true), tool(false)),
  row("noise-b", "noise", "caret", tool(false), tool(false)),
  row("same-a", "identical", "identical", tool(false), tool(false)),
];

describe("scoreTool", () => {
  test("counts what each tool caught and wrongly flagged", () => {
    const ps = scoreTool(rows, "pixelslash");
    expect(ps).toMatchObject({
      realCaught: 2,
      realTotal: 2,
      noiseFlagged: 1,
      noiseTotal: 2,
      identicalFlagged: 0,
      identicalTotal: 1,
    });
    const argos = scoreTool(rows, "argos");
    expect(argos).toMatchObject({ realCaught: 1, noiseFlagged: 0 });
  });

  test("mean IoU is over the real cases the tool caught", () => {
    expect(scoreTool(rows, "pixelslash").meanIouCaught).toBe(0.75);
    expect(scoreTool(rows, "argos").meanIouCaught).toBe(1);
  });

  test("the paired IoU counts only the real cases both tools flagged", () => {
    expect(scoreTool(rows, "pixelslash").meanIouBoth).toBe(0.5);
    expect(scoreTool(rows, "argos").meanIouBoth).toBe(1);
    const alone = rows.map((r) => ({ ...r, argos: null }));
    expect(scoreTool(alone, "pixelslash").meanIouBoth).toBeNull();
  });

  test("per-kind hit rate treats leaving noise alone as a hit", () => {
    const caret = scoreTool(rows, "pixelslash").byKind.find((k) => k.kind === "caret");
    expect(caret).toMatchObject({ hit: 1, total: 2 });
  });

  test("median time ignores tools that report none", () => {
    expect(scoreTool(rows, "pixelslash").medianMs).toBe(1);
    const untimed = rows.map((r) => ({ ...r, argos: tool(false, null, null) }));
    expect(scoreTool(untimed, "argos").medianMs).toBeNull();
  });
});

describe("disagreements", () => {
  test("verdict disagreements are where the changed flags differ", () => {
    expect(verdictDisagreements(rows).map((r) => r.case.name)).toEqual(["real-a", "noise-a"]);
  });

  test("location disagreements need both tools to flag a real case", () => {
    expect(locationDisagreements(rows).map((r) => r.case.name)).toEqual(["real-b"]);
  });

  test("a run without Argos has no disagreements", () => {
    expect(verdictDisagreements(rows.map((r) => ({ ...r, argos: null })))).toEqual([]);
  });
});
