import { describe, expect, test } from "vitest";
import { NotFoundError } from "./db";
import {
  createOrg,
  createProject,
  getProject,
  getProjectWithOrg,
  inviteMember,
  listOrgs,
} from "./orgs";
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
      expect.objectContaining({ id: org.id, projects: [project] }),
    ]);
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
