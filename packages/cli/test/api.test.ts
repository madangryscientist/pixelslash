import { describe, expect, test } from "vitest";
import { apiClient, RemoteError, type FetchLike } from "../src/api.ts";

const SERVER = "https://ps.example";

const answering =
  (status: number, body: string, headers: Record<string, string> = {}): FetchLike =>
  async () =>
    new Response(body, { status, headers });

async function refused(fetch: FetchLike): Promise<string> {
  const err = await apiClient(SERVER, "psu_secret", fetch)
    .get("/api/v1/projects")
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  if (!(err instanceof RemoteError)) throw new Error(`expected a RemoteError, got ${String(err)}`);
  return err.message;
}

describe("a refused request", () => {
  test("a non-API answer names the status, the cf-ray and the start of the body", async () => {
    const page = `<!DOCTYPE html><title>520: Web server is returning an unknown error</title>${"x".repeat(400)}`;
    const msg = await refused(answering(520, page, { "cf-ray": "a5c12f8309c3cd06-AMS" }));
    const head = page.slice(0, 200);
    expect(msg).toBe(
      `GET /api/v1/projects -> 520 not the API's answer (cf-ray a5c12f8309c3cd06-AMS; body ${JSON.stringify(head)})`,
    );
    expect(msg).not.toContain("psu_secret");
  });

  test("with no cf-ray and no body it says so", async () => {
    expect(await refused(answering(502, ""))).toBe(
      "GET /api/v1/projects -> 502 not the API's answer (no cf-ray; empty body)",
    );
  });

  test("the body is cut at 200 bytes, not 200 characters", async () => {
    const msg = await refused(answering(520, "é".repeat(150)));
    expect(msg).toContain(`body ${JSON.stringify("é".repeat(100))}`);
  });

  test("the API's own error is shown as it was, with no edge detail", async () => {
    const body = JSON.stringify({ error: { code: "unauthorized", message: "bad token" } });
    expect(await refused(answering(401, body, { "cf-ray": "r1" }))).toBe(
      `GET /api/v1/projects -> 401 unauthorized: bad token; run \`pixelslash login --server ${SERVER}\``,
    );
  });
});

describe("a request with no answer", () => {
  test("a socket the server closes names the call, the time and the error's code", async () => {
    // A real server that reads the request and hangs up without a byte back, as at 21:03Z in
    // hackcove CI. Before this the line said only `cannot reach <server>: <message>`.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.end();
        },
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const before = Date.now();
      const err = await apiClient(url, "psu_secret", fetch)
        .get("/api/v1/projects")
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      if (!(err instanceof RemoteError))
        throw new Error(`expected a RemoteError, got ${String(err)}`);
      const match =
        /^GET \/api\/v1\/projects: cannot reach (\S+) at (\S+) \(ECONNRESET: .+\)$/.exec(
          err.message,
        );
      expect(match?.[1]).toBe(url);
      const at = Date.parse(match?.[2] ?? "");
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    } finally {
      server.stop(true);
    }
  });
});
