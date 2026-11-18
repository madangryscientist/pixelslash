import { describe, expect, test } from "vitest";
import type { ProcLike, SpawnProc } from "../src/index.ts";
import { judgePage, resolveJudge } from "../src/judge.ts";
import { renderIndex } from "../src/report.ts";

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

function proc(stdout: string): ProcLike {
  return {
    stdout: stream(stdout),
    stderr: stream(""),
    exited: Promise.resolve(0),
    exitCode: 0,
    signalCode: null,
  };
}

const violation: SpawnProc = () => proc("VIOLATION: the fill is red, not blue");
const none = () => null;
const mlx = (bin: string) => (bin === "mlx_vlm.generate" ? "/bin/mlx" : null);
const ollama = (bin: string) => (bin === "ollama" ? "/bin/ollama" : null);

describe("choosing the judge", () => {
  test("mlx, then ollama, then none", () => {
    expect(resolveJudge({ which: mlx })).toBe("mlx");
    expect(resolveJudge({ which: ollama })).toBe("ollama");
    expect(resolveJudge({ which: none })).toBeNull();
  });
});

describe("the verdict line", () => {
  test("a colon after VIOLATION is not part of the reason", async () => {
    const found = await judgePage("/shots/a/live.png", {
      dsDir: "/ds",
      components: ["button.png"],
      spawn: violation,
      kind: "mlx",
    });
    expect(found).toEqual([{ component: "button", reason: "the fill is red, not blue" }]);
  });
});

describe("the route index", () => {
  test("says why a route was not judged, and defaults to no judge", () => {
    const row = { path: "/", slug: "root", already: 0, fresh: 0, skipped: true, changedPixels: 0 };
    expect(renderIndex([{ ...row, skipReason: "judge timeout" }], false)).toContain(
      "skip: judge timeout",
    );
    expect(renderIndex([row], false)).toContain("skip: no judge");
  });
});
