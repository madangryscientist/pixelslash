import { afterAll, describe, expect, test } from "vitest";
import { uploadSnapshots } from "../src/upload.ts";
import { fakeServer } from "./fake-server.ts";
import { cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

// What `vite preview` answers when its proxy to workerd hits a reset socket (ob 1630).
const PROXY_500 = () =>
  new Response(
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>TypeError: fetch failed<br> &nbsp; &nbsp;at Object.processResponse (undici/index.js:237:16)</pre>\n</body>\n</html>\n',
    { status: 500, headers: { "content-type": "text/html" } },
  );

async function upload(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  const { dir: cwd } = await repo(1, 1);
  const dir = await snapshotDir([entry("home")]);
  const warnings: string[] = [];
  const waits: number[] = [];
  const run = uploadSnapshots(
    { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
    {
      fetch,
      warn: (m) => warnings.push(m),
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  return { run, warnings, waits };
}

describe("uploadSnapshots retries what the API never answered", () => {
  test("a 500 from a proxy in front of the API is tried again, and the upload completes", async () => {
    let refused = 0;
    const server = fakeServer((c) =>
      c.url.endsWith("/builds") && refused++ === 0 ? PROXY_500() : undefined,
    );
    const { run, warnings, waits } = await upload(server.fetch);
    await expect(run).resolves.toMatchObject({ buildId: "b1", snapshots: 1 });
    expect(warnings).toEqual([
      "upload: open build: POST /api/v1/builds -> 500 TypeError: fetch failed; trying again (2/3)",
    ]);
    expect(waits).toEqual([1000]);
    expect(server.calls.map((c) => c.method)).toEqual(["POST", "POST", "PUT", "POST"]);
  });

  test("a retried finalise that meets a run still going is a failure, not a pass", async () => {
    let refused = 0;
    const server = fakeServer((c) => {
      if (!c.url.endsWith("/finalize")) return undefined;
      return refused++ === 0 ? PROXY_500() : Response.json({ id: "b1", status: "processing" });
    });
    const { run } = await upload(server.fetch);
    await expect(run).rejects.toThrow(
      "upload failed: finalize: build b1 is still processing on the server",
    );
  });

  test("a finalise the API never answered stops after 3 tries, naming the step and the answer", async () => {
    const server = fakeServer((c) => (c.url.endsWith("/finalize") ? PROXY_500() : undefined));
    const { run, warnings, waits } = await upload(server.fetch);
    await expect(run).rejects.toThrow(
      "upload failed: finalize: POST /api/v1/builds/b1/finalize -> 500 TypeError: fetch failed (after 3 tries)",
    );
    expect(waits).toEqual([1000, 2000]);
    expect(warnings).toHaveLength(2);
    expect(server.calls.filter((c) => c.url.endsWith("/finalize"))).toHaveLength(3);
  });

  test("a connection that fails is tried again", async () => {
    const server = fakeServer();
    let thrown = 0;
    const { run, warnings } = await upload(async (url, init) => {
      if (thrown++ === 0) throw new Error("The socket connection was closed unexpectedly");
      return server.fetch(url, init);
    });
    await expect(run).resolves.toMatchObject({ buildId: "b1" });
    expect(warnings[0]).toMatch(
      /^upload: open build: POST https:\/\/ps\.example\/api\/v1\/builds: The socket/,
    );
  });

  test("an error the API answered is not tried again", async () => {
    const server = fakeServer((c) =>
      c.method === "PUT" ? Response.json({ error: "R2 put failed" }, { status: 500 }) : undefined,
    );
    const { run, warnings } = await upload(server.fetch);
    await expect(run).rejects.toThrow(
      "upload failed: upload home / chromium / 1280x720 / light: PUT /api/v1/builds/b1/snapshots -> 500 R2 put failed",
    );
    expect(warnings).toEqual([]);
    expect(server.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });
});
