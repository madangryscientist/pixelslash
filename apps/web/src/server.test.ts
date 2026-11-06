import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { ABANDONED_AFTER_MS, ABANDONED_REASON } from "#/db/abandoned";
import { createOrg, createProject } from "#/db/orgs";
import { builds } from "#/db/schema";
import { testDb } from "#/db/test-db";
import { signInGithubUser } from "#/db/users";

// The Worker's entry reads its bindings through `cloudflare:workers`, which Node does not have.
const held = vi.hoisted(() => ({
  db: undefined as unknown,
  retention: undefined as number | undefined,
}));
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: () => new Response() } }));
vi.mock("#/server/env", () => ({
  database: () => held.db,
  retentionDays: () => held.retention,
  retentionDelete: () => false,
  sweepStore: () => {
    throw new Error("retention is off: the store must not be opened");
  },
  checkRunDeps: (db: unknown) => ({ db, app: null, token: null, publicUrl: undefined }),
  blobStore: () => undefined,
  modelFetch: () => undefined,
  modelKeySecret: () => undefined,
  startRefusal: () => undefined,
}));

const failNoScheduled = () => {
  throw new Error("the Worker has no scheduled handler");
};

describe("the Worker's scheduled sweep", () => {
  test("with retention off it still ends an abandoned build", async () => {
    const db = testDb();
    const ada = await signInGithubUser(db, {
      githubId: 1,
      login: "ada",
      name: null,
      avatarUrl: null,
    });
    const org = await createOrg(db, ada.id, "Acme");
    const project = await createProject(db, ada.id, org.id, "web");
    await db.insert(builds).values({
      id: "gone",
      projectId: project.id,
      commitSha: "abc",
      branch: "feat/x",
      status: "uploading",
      createdAt: new Date(Date.now() - ABANDONED_AFTER_MS - 60 * 60 * 1000),
    });
    held.db = db;
    held.retention = undefined;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { default: worker } = await import("./server");
    await Reflect.apply(worker.scheduled ?? failNoScheduled, worker, [{}, {}, {}]);

    const [row] = await db.select().from(builds).where(eq(builds.id, "gone"));
    expect(row).toMatchObject({ status: "errored", error: ABANDONED_REASON });
  });
});
