import { describe, expect, test } from "vitest";
import { get, world } from "./test-read";

const READS = [
  "/api/v1/projects",
  "/api/v1/projects/p/builds",
  "/api/v1/projects/p/detection-flags",
  "/api/v1/builds/b",
  "/api/v1/snapshots/s",
];
describe("the read API's errors (ob 1729)", () => {
  test.each(READS)("%s is a 401 without a token, in the coded error shape", async (path) => {
    const { deps } = await world();
    expect(await get(deps, path, null)).toEqual({
      status: 401,
      body: {
        api_version: 1,
        error: { code: "unauthorized", message: "missing, wrong, expired or revoked token" },
      },
    });
    expect((await get(deps, path, "psu_nope")).status).toBe(401);
  });

  test("an unknown path is a coded 404, a wrong method a coded 405", async () => {
    const w = await world();
    expect(await get(w.deps, "/api/v1/nope", w.ada)).toEqual({
      status: 404,
      body: { api_version: 1, error: { code: "not_found", message: "not found" } },
    });
    const post = await get(w.deps, "/api/v1/projects", w.ada, { method: "PUT" });
    expect(post.status).toBe(405);
    expect(post.body.error.code).toBe("method_not_allowed");
  });

  test("the upload endpoints keep their plain-string errors", async () => {
    const w = await world();
    const res = await get(w.deps, `/api/v1/builds/${w.otherBuild.id}/finalize`, w.acme.token, {
      method: "POST",
    });
    expect(res).toEqual({ status: 404, body: { error: "build not found" } });
    expect((await get(w.deps, "/api/v1/builds", null, { method: "POST" })).body).toEqual({
      error: "missing, wrong, expired or revoked token",
    });
  });
});

describe("the minimum CLI version (ob 1729)", () => {
  test("a CLI below the minimum is told to upgrade, in each endpoint's error shape", async () => {
    const w = await world();
    const deps = { ...w.deps, minCliVersion: "0.2.0" };
    const old = { "user-agent": "pixelslash/0.1.9" };
    const read = await get(deps, "/api/v1/projects", w.ada, { headers: old });
    expect(read.status).toBe(426);
    expect(read.body.error).toEqual({
      code: "cli_outdated",
      message: "upgrade the CLI: this server needs pixelslash 0.2.0 or newer",
    });
    const up = await get(deps, "/api/v1/builds", w.acme.token, { headers: old, method: "POST" });
    expect(up).toEqual({
      status: 426,
      body: { error: "upgrade the CLI: this server needs pixelslash 0.2.0 or newer" },
    });
  });

  test("a CLI at or above it, any other client, and no minimum are all served", async () => {
    const w = await world();
    const deps = { ...w.deps, minCliVersion: "0.2.0" };
    for (const ua of ["pixelslash/0.2.0", "pixelslash/0.10.0", "pixelslash/1.0.0", "curl/8.0"])
      expect(
        (await get(deps, "/api/v1/projects", w.ada, { headers: { "user-agent": ua } })).status,
      ).toBe(200);
    const any = { "user-agent": "pixelslash/0.0.1" };
    expect((await get(w.deps, "/api/v1/projects", w.ada, { headers: any })).status).toBe(200);
  });
});
