/** Run one implementation on one pair (ob 1909): the command, a timeout, and a named failure instead of a throw. */
import { parseImplOutput, SPAWN_AT_ENV, type ImplOutput } from "./contract.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;

/** `--decode`: both files at once, or one after the other (an implementation's default). */
export type DecodeMode = "parallel" | "sequential";

/** Why one invocation gave no usable answer. */
export type ImplFailure =
  | { kind: "start"; message: string }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "exit"; code: number | null; stderr: string }
  | { kind: "output"; message: string };

type ImplRun =
  | { ok: true; output: ImplOutput; wallMs: number }
  | { ok: false; failure: ImplFailure; wallMs: number };

/** One line for a report: `exit 3: cannot decode head.png`, `timeout after 60000 ms`. */
export function describeFailure(f: ImplFailure): string {
  if (f.kind === "start") return `cannot start: ${f.message}`;
  if (f.kind === "timeout") return `timeout after ${f.timeoutMs} ms`;
  if (f.kind === "output") return `bad output: ${f.message}`;
  const first = f.stderr.split("\n").find((l) => l.trim() !== "") ?? "";
  return `exit ${f.code ?? "by signal"}${first === "" ? "" : `: ${first.slice(0, 160)}`}`;
}

/** `--impl` takes a command and its leading arguments, split on whitespace (no quoting). */
export function splitCommand(command: string): string[] {
  const argv = command.trim().split(/\s+/);
  if (argv[0] === undefined || argv[0] === "") throw new Error("--impl needs a command");
  return argv;
}

type Tracked = Set<ReturnType<typeof Bun.spawn>>;

/**
 * `<command> diff <base> <head> --json [--decode <mode>]`, one process. Never throws on the
 * implementation's account. The spawn stamp goes in the child's environment (`PS_BENCH_SPAWN_AT`, epoch
 * ms) for an implementation that reports `startup_ms`.
 */
export async function invokeImpl(
  command: string,
  basePng: string,
  headPng: string,
  options: { timeoutMs?: number; running?: Tracked; decode?: DecodeMode | undefined } = {},
): Promise<ImplRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  const wall = () => performance.now() - started;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    const argv = [...splitCommand(command), "diff", basePng, headPng, "--json"];
    if (options.decode) argv.push("--decode", options.decode);
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, [SPAWN_AT_ENV]: String(performance.timeOrigin + performance.now()) },
    });
  } catch (e) {
    return { ok: false, failure: { kind: "start", message: errorText(e) }, wallMs: wall() };
  }
  options.running?.add(proc);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      streamText(proc.stdout),
      streamText(proc.stderr),
      proc.exited,
    ]);
    const wallMs = wall();
    if (timedOut) return { ok: false, failure: { kind: "timeout", timeoutMs }, wallMs };
    if (code !== 0) return { ok: false, failure: { kind: "exit", code, stderr }, wallMs };
    try {
      return { ok: true, output: parseImplOutput(stdout), wallMs };
    } catch (e) {
      return { ok: false, failure: { kind: "output", message: errorText(e) }, wallMs };
    }
  } finally {
    clearTimeout(timer);
    options.running?.delete(proc);
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const streamText = (s: unknown): Promise<string> =>
  s instanceof ReadableStream ? new Response(s).text() : Promise.resolve("");
