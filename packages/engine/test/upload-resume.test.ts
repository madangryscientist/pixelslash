import { afterAll, describe, expect, test } from "vitest";
import { uploadSnapshots } from "../src/upload.ts";
import { fakeServer } from "./fake-server.ts";
import { cleanup, entry, gitOpts, repo, snapshotDir } from "./upload-fixtures.ts";

afterAll(cleanup);

/** A finalise that answers each call with the next reply in `replies`. */
async function upload(replies: object[]) {
  let n = 0;
  const server = fakeServer((c) =>
    c.url.endsWith("/finalize") ? Response.json(replies[n++] ?? replies.at(-1)) : undefined,
  );
  const { dir: cwd } = await repo(1, 1);
  const dir = await snapshotDir([entry("home")]);
  const warnings: string[] = [];
  const run = uploadSnapshots(
    { dir, server: "https://ps.example", token: "t", git: gitOpts(cwd) },
    { fetch: server.fetch, warn: (m) => warnings.push(m), sleep: async () => {} },
  );
  const finalises = () => server.calls.filter((c) => c.url.endsWith("/finalize")).length;
  return { run, warnings, finalises };
}

const errored = (unmeasured: number) => ({
  id: "b1",
  status: "errored",
  error: `diff ceiling: ${unmeasured} left`,
  unmeasured,
});

describe("uploadSnapshots resumes a diff the server stopped at its budget (ob 1645)", () => {
  test("finalises again while shots are left, until the build has a verdict", async () => {
    const { run, warnings, finalises } = await upload([
      errored(40),
      errored(5),
      { id: "b1", status: "changes", error: null, unmeasured: 0 },
    ]);
    await expect(run).resolves.toMatchObject({ buildId: "b1" });
    expect(finalises()).toBe(3);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/40 of 1 shots still to measure/);
  });

  test("stops when a finalise measured nothing more, and says the build is errored", async () => {
    const { run, warnings, finalises } = await upload([errored(7), errored(7)]);
    await run;
    expect(finalises()).toBe(2);
    expect(warnings.at(-1)).toMatch(/build b1 is errored on the server: diff ceiling: 7 left/);
  });

  test("a reply without a count is not retried", async () => {
    const { run, warnings, finalises } = await upload([
      { id: "b1", status: "errored", error: "boom" },
    ]);
    await run;
    expect(finalises()).toBe(1);
    expect(warnings).toEqual(["upload: build b1 is errored on the server: boom"]);
  });
});
