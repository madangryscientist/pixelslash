import { describe, expect, test } from "vitest";
import {
  askOpencode,
  JudgeError,
  OPENCODE_MODEL_ENV,
  type ProcLike,
  type SpawnProc,
} from "../src/index.ts";
import { askVision, judgePage, resolveJudge } from "../src/judge.ts";
import { renderIndex } from "../src/report.ts";

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

function proc(stdout: string, stderr = "", exitCode: number | null = 0): ProcLike {
  return {
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode: exitCode === null ? "SIGTERM" : null,
  };
}

type Seen = { cmd: string[]; opts: Parameters<SpawnProc>[1] };

function recorder(make: () => ProcLike): { spawn: SpawnProc; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    spawn: (cmd, opts) => {
      seen.push({ cmd, opts });
      return make();
    },
  };
}

const MODEL = "opencode-go/some-vision-model";
const ANSWER = "The button is red.";

describe("the opencode judge: the call", () => {
  test("runs opencode run with one --file per image, in order, and no --auto", async () => {
    const { spawn, seen } = recorder(() => proc(ANSWER));
    await askOpencode("what changed?", ["/shots/a/main.png", "/shots/a/branch.png"], {
      model: MODEL,
      spawn,
    });
    const { cmd, opts } = seen[0]!;
    expect(cmd.slice(0, 2)).toEqual(["opencode", "run"]);
    expect(cmd).toContain("--standalone");
    expect(cmd.slice(cmd.indexOf("-m"), cmd.indexOf("-m") + 2)).toEqual(["-m", MODEL]);
    const files = cmd.flatMap((a, i) => (cmd[i - 1] === "--file" ? [a] : []));
    expect(files).toEqual(["/shots/a/main.png", "/shots/a/branch.png"]);
    expect(cmd.at(-1)).toBe("what changed?");
    expect(cmd).not.toContain("--auto");
    expect(cmd.join(" ")).not.toMatch(/auto|serve|--server|--attach/);
    expect(opts.cwd).toBe("/shots/a");
    expect(opts.env!.PWD).toBe("/shots/a");
    expect(opts).toMatchObject({ stdout: "pipe", stderr: "pipe" });
    expect(opts.timeout).toBeGreaterThan(0);
  });

  test("a call with no images runs in the directory it is given", async () => {
    const { spawn, seen } = recorder(() => proc(ANSWER));
    await askOpencode("summarise", [], { model: MODEL, spawn, cwd: "/work/call-1" });
    const { cmd, opts } = seen[0]!;
    expect(cmd).not.toContain("--file");
    expect(cmd.at(-1)).toBe("summarise");
    expect(opts.cwd).toBe("/work/call-1");
    expect(opts.env!.PWD).toBe("/work/call-1");
  });

  test("runs as an agent that denies every action on every resource", async () => {
    const { spawn, seen } = recorder(() => proc(ANSWER));
    await askOpencode("p", ["/x/a.png"], { model: MODEL, spawn });
    const { cmd, opts } = seen[0]!;
    const agent = cmd[cmd.indexOf("--agent") + 1]!;
    const config = JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT!);
    expect(config.agents[agent].permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
    ]);
  });

  test("the key is not put on the command line or in the config", async () => {
    const { spawn, seen } = recorder(() => proc(ANSWER));
    await askOpencode("p", ["/x/a.png"], { model: MODEL, spawn });
    const { cmd, opts } = seen[0]!;
    expect(cmd.join(" ")).not.toMatch(/key/i);
    expect(opts.env!.OPENCODE_CONFIG_CONTENT).not.toMatch(/key/i);
  });
});

describe("the opencode judge: the answer", () => {
  test("loses opencode's framing and colour codes", async () => {
    const framed = `\x1b[0m\n> pixelslash-judge · some-vision-model\n\x1b[0m\n${ANSWER}\n`;
    const { spawn } = recorder(() => proc(framed));
    expect(await askOpencode("p", ["/x/a.png"], { model: MODEL, spawn })).toBe(ANSWER);
  });

  test("askVision keeps a line that opens with an arrow", async () => {
    const { spawn } = recorder(() => proc("→ the card moved\nthe border is thinner"));
    const answer = await askVision("p", ["/x/a.png"], { spawn, kind: `opencode:${MODEL}` });
    expect(answer).toBe("→ the card moved\nthe border is thinner");
  });
});

const failure = (spawn: SpawnProc) =>
  askOpencode("p", ["/x/a.png"], { model: MODEL, spawn }).catch((e: unknown) => e);

describe("the opencode judge: failures are named", () => {
  test("a missing binary", async () => {
    const gone = Object.assign(new Error("Executable not found in $PATH"), { code: "ENOENT" });
    const error = await failure(() => {
      throw gone;
    });
    expect(error).toBeInstanceOf(JudgeError);
    expect(error).toMatchObject({ reason: "binary missing" });
  });

  test("a timeout (the process was killed)", async () => {
    const error = await failure(() => proc("", "", null));
    expect(error).toMatchObject({ reason: "timeout" });
  });

  test("a non-zero exit, with the tail of stderr", async () => {
    const error = await failure(() => proc("", "ProviderError: bad key", 1));
    expect(error).toMatchObject({ reason: "exit" });
    expect(error).toMatchObject({ message: expect.stringContaining("bad key") });
  });

  test("an empty answer, even when only framing was printed", async () => {
    const error = await failure(() => proc("\n> pixelslash-judge · m\n\n"));
    expect(error).toMatchObject({ reason: "empty answer" });
  });
});

const none = () => null;
const mlx = (bin: string) => (bin === "mlx_vlm.generate" ? "/bin/mlx" : null);
const ollama = (bin: string) => (bin === "ollama" ? "/bin/ollama" : null);
const opencode = (bin: string) => (bin === "opencode" ? "/bin/opencode" : null);

describe("choosing the judge", () => {
  test("with nothing configured: mlx, then ollama, then none", () => {
    expect(resolveJudge({ which: mlx, env: {} })).toBe("mlx");
    expect(resolveJudge({ which: ollama, env: {} })).toBe("ollama");
    expect(resolveJudge({ which: none, env: {} })).toBeNull();
  });

  test("opencode on PATH alone chooses nothing", () => {
    expect(resolveJudge({ which: opencode, env: {} })).toBeNull();
  });

  test("the env var chooses opencode and its model, over a local engine", () => {
    const env = { [OPENCODE_MODEL_ENV]: MODEL };
    expect(resolveJudge({ which: mlx, env })).toBe(`opencode:${MODEL}`);
    expect(resolveJudge({ which: none, env })).toBe(`opencode:${MODEL}`);
  });

  test("a blank env var is not a choice", () => {
    expect(resolveJudge({ which: mlx, env: { [OPENCODE_MODEL_ENV]: "  " } })).toBe("mlx");
  });
});

describe("the verdict line", () => {
  test("a colon after VIOLATION is not part of the reason", async () => {
    const { spawn } = recorder(() => proc("VIOLATION: the fill is red, not blue"));
    const kind = `opencode:${MODEL}` as const;
    const found = await judgePage("/shots/a/live.png", {
      dsDir: "/ds",
      components: ["button.png"],
      spawn,
      kind,
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
