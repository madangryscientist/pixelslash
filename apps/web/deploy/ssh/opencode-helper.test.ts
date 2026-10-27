import { existsSync } from "node:fs";
import type { ProcLike, SpawnProc } from "@pixelslash/engine/judge";
import { describe, expect, test } from "vitest";
import { CHAT_PATH, createHandler } from "./opencode-helper";

const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

const proc = (stdout: string, stderr = "", exitCode: number | null = 0): ProcLike => ({
  stdout: stream(stdout),
  stderr: stream(stderr),
  exited: Promise.resolve(exitCode),
  exitCode,
  signalCode: exitCode === null ? "SIGTERM" : null,
});

type Seen = { cmd: string[]; opts: Parameters<SpawnProc>[1]; existed: boolean[] };

function recorder(make: () => ProcLike) {
  const seen: Seen[] = [];
  const spawn: SpawnProc = (cmd, opts) => {
    const files = cmd.filter((_, i) => cmd[i - 1] === "--file");
    seen.push({ cmd, opts, existed: files.map((f) => existsSync(f)) });
    return make();
  };
  return { spawn, seen };
}

const PNG = `data:image/png;base64,${Buffer.from("not really a png").toString("base64")}`;
const MODEL = "opencode-go/claude-haiku-5-5";

const chat = (over: Record<string, unknown> = {}, images = [PNG, PNG, PNG]) =>
  new Request(`http://127.0.0.1:4180${CHAT_PATH}`, {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Say what changed." },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
      ...over,
    }),
  });

const quiet = { log: () => undefined };

/** The value at `path` of a parsed reply, or undefined. */
const at = (value: unknown, ...path: (string | number)[]): unknown =>
  path.reduce<unknown>(
    (v, key) => (typeof v === "object" && v ? Reflect.get(v, key) : undefined),
    value,
  );

/** A request to the helper with no body; the POST one carries an empty object. */
const plain = (path: string, method: string) =>
  method === "POST"
    ? new Request(`http://127.0.0.1:4180${path}`, { method: "POST", body: "{}" })
    : new Request(`http://127.0.0.1:4180${path}`, { method });

const gone: SpawnProc = () => {
  throw Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
};

describe("opencode helper", () => {
  test("answers a chat completion through the tool-less runner and removes the temp files", async () => {
    const { spawn, seen } = recorder(() => proc("LABEL noise\nWHY a sub-pixel shift\n"));
    const res = await createHandler({ spawn, ...quiet })(chat());
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(at(body, "object")).toBe("chat.completion");
    expect(at(body, "choices", 0, "message")).toEqual({
      role: "assistant",
      content: "LABEL noise\nWHY a sub-pixel shift",
    });
    expect(at(body, "choices", 0, "finish_reason")).toBe("stop");

    const [call] = seen;
    const argv = call?.cmd ?? [];
    expect(argv.slice(0, 2)).toEqual(["opencode", "run"]);
    expect(argv).not.toContain("--auto");
    expect(argv[argv.indexOf("-m") + 1]).toBe(MODEL);
    expect(argv.at(-1)).toBe("Say what changed.");
    const files = argv.filter((_, i) => argv[i - 1] === "--file");
    expect(files.map((f) => f.split("/").at(-1))).toEqual([
      "image-1.png",
      "image-2.png",
      "image-3.png",
    ]);
    expect(call?.existed).toEqual([true, true, true]);
    expect(call?.opts.cwd).toBe(files[0]?.replace(/\/[^/]*$/, ""));
    expect(files.some((f) => existsSync(f))).toBe(false);
    expect(existsSync(call?.opts.cwd ?? "")).toBe(false);
  });

  test("answers the build summary's text-only call in the call's own temp dir", async () => {
    const { spawn, seen } = recorder(() => proc("Two shots changed."));
    const res = await createHandler({ spawn, ...quiet })(chat({}, []));
    expect(res.status).toBe(200);
    const argv = seen[0]?.cmd ?? [];
    expect(argv).not.toContain("--file");
    expect(seen[0]?.opts.cwd).toMatch(/ps-opencode-/);
    expect(existsSync(seen[0]?.opts.cwd ?? "")).toBe(false);
  });

  test("bounds the run by its own timeout, not the runner's five minutes", async () => {
    const { spawn, seen } = recorder(() => proc("ok"));
    await createHandler({ spawn, runTimeoutMs: 1234, ...quiet })(chat());
    expect(seen[0]?.opts.timeout).toBe(1234);
  });

  test("serves nothing but POST /v1/chat/completions", async () => {
    const { spawn, seen } = recorder(() => proc("ok"));
    const handle = createHandler({ spawn, ...quiet });
    const call = (path: string, method = "POST") => handle(plain(path, method));
    expect((await call("/v1/models", "GET")).status).toBe(404);
    expect((await call("/chat/completions")).status).toBe(404);
    expect((await call("/v1/chat/completions/x")).status).toBe(404);
    expect((await call("/")).status).toBe(404);
    expect((await call(CHAT_PATH, "GET")).status).toBe(405);
    expect((await call(CHAT_PATH, "DELETE")).status).toBe(405);
    expect(seen).toHaveLength(0);
  });

  test.each([
    ["a model that is a flag", { model: "--auto/x" }, [PNG]],
    ["a model with no provider", { model: "gpt" }, [PNG]],
    ["ten images", {}, Array.from({ length: 10 }, () => PNG)],
    ["a remote image URL", {}, ["https://example.com/a.png"]],
    ["a data URL that is not an image", {}, ["data:text/html;base64,PGI+"]],
  ])("refuses %s with a 400 and runs nothing", async (_name, over, images) => {
    const { spawn, seen } = recorder(() => proc("ok"));
    const res = await createHandler({ spawn, ...quiet })(chat(over, images));
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  test("refuses a body that is not JSON", async () => {
    const res = await createHandler({ ...quiet })(
      new Request(`http://127.0.0.1:4180${CHAT_PATH}`, { method: "POST", body: "nope" }),
    );
    expect(res.status).toBe(400);
  });

  test("a prompt that opens with a dash is not read as a flag", async () => {
    const { spawn, seen } = recorder(() => proc("ok"));
    const req = chat();
    const body = JSON.parse(await req.clone().text());
    body.messages[0].content[0].text = "--auto describe";
    await createHandler({ spawn, ...quiet })(
      new Request(req.url, { method: "POST", body: JSON.stringify(body) }),
    );
    expect(seen[0]?.cmd.at(-1)).toBe("Task: --auto describe");
  });

  test.each([
    ["a timeout", () => proc("", "", null), 504, "opencode: timeout"],
    ["a non-zero exit", () => proc("", "sk-secret-in-stderr", 1), 502, "opencode: exit"],
    ["an empty answer", () => proc("   \n"), 502, "opencode: empty answer"],
  ])(
    "%s is a named failure that leaks nothing of opencode's stderr, in the reply or the journal",
    async (_name, make, status, message) => {
      const { spawn } = recorder(make);
      const lines: string[] = [];
      const res = await createHandler({ spawn, log: (l) => lines.push(l) })(chat());
      expect(res.status).toBe(status);
      expect(at(await res.json(), "error", "message")).toBe(message);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(MODEL);
      expect(lines[0]).not.toContain("sk-secret");
    },
  );

  test("a missing binary is a 502", async () => {
    const res = await createHandler({ spawn: gone, ...quiet })(chat());
    expect(res.status).toBe(502);
    expect(at(await res.json(), "error", "message")).toBe("opencode: binary missing");
  });

  test("the journal line names the call and never its prompt or images", async () => {
    const { spawn } = recorder(() => proc("an answer"));
    const lines: string[] = [];
    await createHandler({ spawn, log: (l) => lines.push(l) })(chat());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^opencode-go\/claude-haiku-5-5 images=3 \d+ms ok 9 chars$/);
  });

  test("runs one call at a time and drops a call whose client went away while it waited", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const running: number[] = [];
    let live = 0;
    let peak = 0;
    const spawn: SpawnProc = () => {
      live++;
      peak = Math.max(peak, live);
      running.push(live);
      const done = gate.then(() => {
        live--;
        return 0;
      });
      return { ...proc("ok"), exited: done };
    };
    const handle = createHandler({ spawn, ...quiet });
    const first = handle(chat());
    const second = handle(chat());
    const abort = new AbortController();
    const waited = handle(
      new Request(chat().url, { method: "POST", body: await chat().text(), signal: abort.signal }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toHaveLength(1);
    abort.abort();
    expect((await waited).status).toBe(499);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(peak).toBe(1);
  });

  test("a call whose client is already gone never starts a run", async () => {
    const { spawn, seen } = recorder(() => proc("ok"));
    const hungUp = AbortSignal.abort();
    const res = await createHandler({ spawn, ...quiet })(
      new Request(chat().url, { method: "POST", body: await chat().text(), signal: hungUp }),
    );
    expect(res.status).toBe(499);
    expect(seen).toHaveLength(0);
  });
});
