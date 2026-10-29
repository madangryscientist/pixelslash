import { describe, expect, test } from "vitest";
import { NotFoundError } from "./db";
import {
  createOrg,
  createProject,
  getProject,
  getProjectWithOrg,
  inviteMember,
  listOrgs,
  withdrawInvite,
} from "./orgs";
import { builds, snapshots } from "./schema";
import { testDb } from "./test-db";
import { createSession, endSession, sessionUser, signInGithubUser } from "./users";

const profile = (githubId: number, login: string) => ({
  githubId,
  login,
  name: null,
  avatarUrl: null,
});

describe("org isolation", () => {
  test("a member of org A cannot read or write org B's projects", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const orgA = await createOrg(db, alice.id, "A");
    const orgB = await createOrg(db, bob.id, "B");
    const projectB = await createProject(db, bob.id, orgB.id, "b-web");

    await expect(getProject(db, alice.id, projectB.id)).rejects.toThrow(NotFoundError);
    await expect(createProject(db, alice.id, orgB.id, "sneaky")).rejects.toThrow(NotFoundError);
    await expect(inviteMember(db, alice, orgB.id, "alice")).rejects.toThrow(NotFoundError);
    expect((await listOrgs(db, alice.id)).map((o) => o.id)).toEqual([orgA.id]);
    expect(await getProject(db, bob.id, projectB.id)).toEqual(projectB);
  });

  test("a project comes with its org's name, and only for a member", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const org = await createOrg(db, alice.id, "Acme");
    const project = await createProject(db, alice.id, org.id, "web");

    expect(await getProjectWithOrg(db, alice.id, project.id)).toEqual({
      project,
      org: { id: org.id, name: "Acme" },
    });
    await expect(getProjectWithOrg(db, bob.id, project.id)).rejects.toThrow(NotFoundError);
  });

  test("an invite becomes a membership when that GitHub login signs in", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "A");
    const project = await createProject(db, alice.id, org.id, "web");
    await inviteMember(db, alice, org.id, "Carol");

    const carol = await signInGithubUser(db, profile(3, "carol"));

    expect(await getProject(db, carol.id, project.id)).toEqual(project);
    expect(await listOrgs(db, carol.id)).toEqual([
      expect.objectContaining({ id: org.id, projects: [{ ...project, latest: null }] }),
    ]);
  });

  test("orgs and projects sort by name ignoring case", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const zed = await createOrg(db, alice.id, "Zed Studio");
    const hack = await createOrg(db, alice.id, "hackcove");
    const pixel = await createOrg(db, alice.id, "Pixel Labs");
    const web = await createProject(db, alice.id, hack.id, "Web");
    const api = await createProject(db, alice.id, hack.id, "api");

    const orgs = await listOrgs(db, alice.id);

    expect(orgs.map((o) => o.id)).toEqual([hack.id, pixel.id, zed.id]);
    expect(orgs[0]?.projects.map((p) => p.id)).toEqual([api.id, web.id]);
  });
});

type Seed = { diffStatus: "changed" | "new" | "unchanged" | null; reviewState?: "accepted" };

/** A build with the given shots, written straight to the tables: these tests read, they do not diff. */
async function seedBuild(
  db: ReturnType<typeof testDb>,
  build: { projectId: string; id: string; at: number; branch?: string },
  shots: Seed[],
) {
  const { projectId, id, at, branch = "main" } = build;
  await db.insert(builds).values({
    id,
    projectId,
    commitSha: id.padEnd(40, "0"),
    branch,
    prNumber: branch === "main" ? null : 7,
    status: "changes",
    createdAt: new Date(at),
  });
  for (const [i, shot] of shots.entries()) {
    await db.insert(snapshots).values({
      id: `${id}-${i}`,
      buildId: id,
      name: `shot-${i}`,
      platform: "linux",
      browser: "chromium",
      viewport: "1280x720",
      theme: "light",
      envFingerprint: "env",
      imageKey: `${id}-${i}.png`,
      ...shot,
    });
  }
}

describe("the organizations overview", () => {
  test("each project carries its latest build and what the shots came to", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "Acme");
    const web = await createProject(db, alice.id, org.id, "web");
    const docs = await createProject(db, alice.id, org.id, "docs");
    await createProject(db, alice.id, org.id, "idle");
    await seedBuild(db, { projectId: web.id, id: "old", at: 1000 }, [{ diffStatus: "changed" }]);
    await seedBuild(db, { projectId: web.id, id: "new", at: 2000, branch: "feat/x" }, [
      { diffStatus: "changed" },
      { diffStatus: "changed", reviewState: "accepted" },
      { diffStatus: "new" },
      { diffStatus: "unchanged" },
      { diffStatus: null },
    ]);
    await seedBuild(db, { projectId: docs.id, id: "d1", at: 1500 }, [{ diffStatus: "unchanged" }]);

    const [overview] = await listOrgs(db, alice.id);
    const byName = Object.fromEntries((overview?.projects ?? []).map((p) => [p.name, p]));

    expect(byName["web"]?.latest).toMatchObject({
      id: "new",
      branch: "feat/x",
      prNumber: 7,
      total: 5,
      counts: { changed: 2, new: 1, unchanged: 1, unmeasured: 1, toReview: 2 },
    });
    expect(byName["docs"]?.latest?.counts.toReview).toBe(0);
    expect(byName["idle"]?.latest).toBeNull();
    // The badge counts projects whose *latest* build is waiting, not shots: only web is.
    expect(overview?.waiting).toBe(1);
  });

  test("members and pending invites are listed, and an invite can be withdrawn", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const org = await createOrg(db, alice.id, "Acme");
    await inviteMember(db, alice, org.id, "Carol");

    const [before] = await listOrgs(db, alice.id);
    expect(before?.members.map((m) => m.login)).toEqual(["alice"]);
    expect(before?.invites).toEqual([expect.objectContaining({ githubLogin: "carol" })]);

    const [pending] = before?.invites ?? [];
    await withdrawInvite(db, alice.id, org.id, pending?.id ?? "");
    expect((await listOrgs(db, alice.id))[0]?.invites).toEqual([]);
    // Withdrawn, so signing in does not join the org.
    const carol = await signInGithubUser(db, profile(3, "carol"));
    expect(await listOrgs(db, carol.id)).toEqual([]);
  });

  test("another org's member cannot withdraw an invite, and a missing id is a 404", async () => {
    const db = testDb();
    const alice = await signInGithubUser(db, profile(1, "alice"));
    const bob = await signInGithubUser(db, profile(2, "bob"));
    const orgA = await createOrg(db, alice.id, "A");
    const orgB = await createOrg(db, bob.id, "B");
    await inviteMember(db, alice, orgA.id, "carol");
    const [pending] = (await listOrgs(db, alice.id))[0]?.invites ?? [];

    await expect(withdrawInvite(db, bob.id, orgA.id, pending?.id ?? "")).rejects.toThrow(
      NotFoundError,
    );
    // Bob is a member of B, but the invite belongs to A.
    await expect(withdrawInvite(db, bob.id, orgB.id, pending?.id ?? "")).rejects.toThrow(
      NotFoundError,
    );
    expect((await listOrgs(db, alice.id))[0]?.invites).toHaveLength(1);
  });
});

describe("sessions", () => {
  test("a session resolves its user until it expires or ends", async () => {
    const db = testDb();
    const user = await signInGithubUser(db, profile(1, "alice"));
    const now = new Date("2026-10-19T00:00:00Z");
    const token = await createSession(db, user.id, now);

    expect((await sessionUser(db, token, now))?.id).toBe(user.id);
    expect(await sessionUser(db, token, new Date("2026-12-01T00:00:00Z"))).toBeNull();
    await endSession(db, token);
    expect(await sessionUser(db, token, now)).toBeNull();
  });
});
