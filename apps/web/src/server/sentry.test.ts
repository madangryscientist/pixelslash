import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { reportError, withOptionalSentry } from "./sentry";

const TOKEN = "psu_0123456789abcdefSECRET";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

afterEach(() => vi.restoreAllMocks());

/** A Sentry ingest on a free port: every envelope POSTed to it, as text. */
function fakeIngest() {
  const raw: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const body = req.headers.get("content-encoding") === "gzip" ? gunzipSync(bytes) : bytes;
      raw.push(new TextDecoder().decode(body));
      return Response.json({ id: "1" });
    },
  });
  return {
    dsn: `http://publickey@127.0.0.1:${server.port}/1`,
    raw,
    stop: () => server.stop(true),
  };
}

/** What the Worker reads of its `ExecutionContext`; the rest (`tracing`, `abort`) is the runtime's. */
type TestContext = Pick<ExecutionContext, "waitUntil" | "passThroughOnException" | "props">;

/** The ExecutionContext the Worker is called with: the work it hands to `waitUntil`, to await. */
function context() {
  const pending: Promise<unknown>[] = [];
  const ctx: TestContext = {
    waitUntil: (work: Promise<unknown>) => void pending.push(work),
    passThroughOnException: () => undefined,
    props: {},
  };
  return { ctx, settled: () => Promise.allSettled(pending) };
}

const request = () =>
  new Request("https://ps.example/api/v1/builds?code=oauthcode&sig=signedsecret", {
    method: "POST",
    headers: { cookie: "ps_session=sessionvalue", authorization: `Bearer ${TOKEN}` },
    body: `{"shot":"data:image/png;base64,${PNG}"}`,
  });

/**
 * `fetch` as the runtime calls it. A plain `Request` has no `cf`, which the handler's type asks
 * for, so the call goes through `Reflect.apply` and the env is the three vars Sentry reads.
 */
function callFetch(
  handler: ReturnType<typeof withOptionalSentry>,
  env: { SENTRY_DSN: string; SENTRY_RELEASE: string; SENTRY_ENVIRONMENT: string },
  ctx: TestContext,
): Response | Promise<Response> {
  return Reflect.apply(handler.fetch, handler, [request(), env, ctx]);
}

const throwing = () =>
  withOptionalSentry({
    fetch: () => {
      throw new Error(`upload blew up for ${TOKEN}`);
    },
  });

describe("the Worker reports to Sentry only when SENTRY_DSN is set (PS-227)", () => {
  test("with no DSN the original handler runs and nothing leaves the machine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("a request was made with no DSN");
    });
    const { ctx, settled } = context();
    const env = { SENTRY_DSN: "", SENTRY_RELEASE: "abc", SENTRY_ENVIRONMENT: "lan" };
    const answered = withOptionalSentry({ fetch: () => new Response("plain") });
    const response = await callFetch(answered, env, ctx);
    expect(await response.text()).toBe("plain");
    // The original handler, unwrapped: its own error reaches the caller as it threw it.
    expect(() => callFetch(throwing(), env, ctx)).toThrow("upload blew up");
    await settled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a thrown error arrives with release and environment, and with no body, cookie, token or image", async () => {
    const ingest = fakeIngest();
    try {
      const { ctx, settled } = context();
      const env = {
        SENTRY_DSN: ingest.dsn,
        SENTRY_RELEASE: "0123abc",
        SENTRY_ENVIRONMENT: "lan",
      };
      await expect(callFetch(throwing(), env, ctx)).rejects.toThrow("upload blew up");
      await settled();
      await vi.waitFor(() => expect(ingest.raw.length).toBeGreaterThan(0));
      const text = ingest.raw.join("\n");
      expect(text).toContain('"release":"0123abc"');
      expect(text).toContain('"environment":"lan"');
      expect(text).toContain("upload blew up");
      for (const secret of [TOKEN, PNG, "sessionvalue", "oauthcode", "signedsecret", "shot"]) {
        expect(text, `the envelope carries ${secret}`).not.toContain(secret);
      }
    } finally {
      await ingest.stop();
    }
  });

  test("reportError never throws, with or without a client", () => {
    expect(() => reportError(new Error("nobody is listening"), { area: "test" })).not.toThrow();
  });
});
