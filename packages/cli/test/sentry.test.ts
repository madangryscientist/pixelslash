import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { CLIENT_VERSION } from "@pixelslash/engine";
import { run } from "../src/run.ts";
import { capture, cleanup, faintPair, tmp } from "./support.ts";
import { gitRepo, snapshotDir as uploadDir } from "./upload-support.ts";

// The engine's `diffPngs`, made to throw an error that carries what must never leave the machine.
const LEAK = {
  token: "psu_0123456789abcdefSECRET",
  png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};
vi.mock(import("../../engine/src/diff.ts"), async (original) => {
  const real = await original();
  return {
    ...real,
    diffPngs: () => {
      throw new Error(`diff blew up on ${LEAK.token} and data:image/png;base64,${LEAK.png}`);
    },
  };
});

afterEach(() => vi.restoreAllMocks());
afterAll(cleanup);

type Envelope = {
  headers: Record<string, unknown>;
  items: Array<[Record<string, unknown>, unknown]>;
};

/** A parsed JSON value as a plain record (an empty one when it is not an object). */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** A Sentry ingest on a free port: keeps every envelope POSTed to it, parsed and as raw text. */
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
    envelopes(): Envelope[] {
      return raw.map((text) => {
        const lines = text.split("\n").filter(Boolean);
        const parsed = lines.map((line) => recordOf(JSON.parse(line)));
        const items: Envelope["items"] = [];
        for (let i = 1; i + 1 < parsed.length; i += 2) items.push([parsed[i] ?? {}, parsed[i + 1]]);
        return { headers: parsed[0] ?? {}, items };
      });
    },
  };
}

describe("the CLI reports to Sentry only when PIXELSLASH_SENTRY_DSN is set (PS-227)", () => {
  test("with no DSN a crash makes no outbound request at all", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("a request was made with no DSN");
    });
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {
      env: {},
    });
    expect(code).toBe(7);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cap.stderr).toContain("FAILED");
  });

  test("a crash arrives with release and environment, and with no token or image data", async () => {
    const ingest = fakeIngest();
    try {
      const dir = await tmp();
      const { live, local } = await faintPair(dir);
      const cap = capture();
      const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {
        env: { PIXELSLASH_SENTRY_DSN: ingest.dsn, PIXELSLASH_SENTRY_ENVIRONMENT: "ci" },
      });
      expect(code).toBe(7);
      const events = ingest
        .envelopes()
        .flatMap((e) => e.items)
        .filter(([header]) => header["type"] === "event")
        .map(([, payload]) => recordOf(payload));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        release: `pixelslash@${CLIENT_VERSION}`,
        environment: "ci",
        tags: { kind: "crash", command: "compare" },
      });
      const everything = ingest.raw.join("\n");
      expect(everything).toContain("diff blew up");
      expect(everything).not.toContain(LEAK.token);
      expect(everything).not.toContain(LEAK.png);
      expect(everything).not.toContain("iVBORw0KGgo");
      expect(events[0]).not.toHaveProperty("request");
      expect(events[0]).not.toHaveProperty("user");
    } finally {
      await ingest.stop();
    }
  });

  test("an unreachable ingest never changes the exit code or hangs the run", async () => {
    const dir = await tmp();
    const { live, local } = await faintPair(dir);
    const cap = capture();
    const code = await run(["--live-png", live, "--local-png", local, "--out", dir], cap.io, {
      env: { PIXELSLASH_SENTRY_DSN: "http://publickey@127.0.0.1:1/1" },
    });
    expect(code).toBe(7);
  });

  test("an UPLOAD FAILED run is reported, and the token it ran with is not in the envelope", async () => {
    const ingest = fakeIngest();
    try {
      const [cwd, dir, cap] = [await gitRepo(), await uploadDir(), capture()];
      const code = await run(["upload", dir, "--server", "https://ps.example"], cap.io, {
        fetch: async () => Response.json({ error: "no" }, { status: 401 }),
        cwd,
        env: { PIXELSLASH_TOKEN: "psci_neverleaves123", PIXELSLASH_SENTRY_DSN: ingest.dsn },
      });
      expect(code).toBe(1);
      const events = ingest
        .envelopes()
        .flatMap((e) => e.items)
        .filter(([header]) => header["type"] === "event")
        .map(([, payload]) => recordOf(payload));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        release: `pixelslash@${CLIENT_VERSION}`,
        environment: "cli",
        tags: { kind: "upload", command: "upload" },
      });
      expect(ingest.raw.join("\n")).toContain("UPLOAD FAILED");
      expect(ingest.raw.join("\n")).not.toContain("psci_neverleaves123");
    } finally {
      await ingest.stop();
    }
  });
});
