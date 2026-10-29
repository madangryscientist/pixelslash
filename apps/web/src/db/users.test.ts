import { describe, expect, test } from "vitest";
import { createOrg, inviteMember, listOrgs } from "./orgs";
import { testDb } from "./test-db";
import { EmailInUseError, signInGithubUser, signInGoogleUser } from "./users";

/** Sign in with Google beside GitHub (PS-274): one user per person, met on a verified email. */

const github = (githubId: number, login: string, email: string | null = null) => ({
  githubId,
  login,
  name: null,
  avatarUrl: null,
  email,
});
const google = (sub: string, email: string) => ({
  sub,
  email,
  name: "Ada",
  avatarUrl: "https://lh3.example/ada.png",
});

describe("signInGoogleUser", () => {
  test("a first Google sign-in creates a user, shown by their email", async () => {
    const db = testDb();
    const user = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    expect(user).toMatchObject({
      googleSub: "g-1",
      githubId: null,
      email: "ada@example.com",
      login: "ada@example.com",
      name: "Ada",
    });
  });

  test("the same subject is the same user, whatever its email says now", async () => {
    const db = testDb();
    const first = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    const again = await signInGoogleUser(db, google("g-1", "ada@new.example"));
    expect(again.id).toBe(first.id);
    expect(again.email).toBe("ada@example.com");
  });

  test("it links to the GitHub user with that verified email, keeping their login", async () => {
    const db = testDb();
    const gh = await signInGithubUser(db, github(1, "ada-gh", "ada@example.com"));
    const user = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    expect(user.id).toBe(gh.id);
    expect(user).toMatchObject({ githubId: 1, googleSub: "g-1", login: "ada-gh" });
  });

  test("an email another Google account holds is refused, not taken over", async () => {
    const db = testDb();
    await signInGoogleUser(db, google("g-1", "ada@example.com"));
    await expect(signInGoogleUser(db, google("g-2", "ada@example.com"))).rejects.toThrow(
      EmailInUseError,
    );
  });
});

describe("signInGithubUser", () => {
  test("it links to the Google user with that verified email, and takes the GitHub login", async () => {
    const db = testDb();
    const g = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    const user = await signInGithubUser(db, github(1, "ada-gh", "ada@example.com"));
    expect(user.id).toBe(g.id);
    expect(user).toMatchObject({ githubId: 1, googleSub: "g-1", login: "ada-gh" });
  });

  test("with no verified email it never links: a second user, and the first keeps its email", async () => {
    const db = testDb();
    const g = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    // `fetchGithubProfile` passes null for an unverified email (`primaryVerifiedEmail`).
    const user = await signInGithubUser(db, github(1, "ada-gh", null));
    expect(user.id).not.toBe(g.id);
    expect(user.email).toBeNull();
  });

  test("a user with one GitHub account is not taken over by another that claims the email", async () => {
    const db = testDb();
    const first = await signInGithubUser(db, github(1, "ada-gh", "ada@example.com"));
    const second = await signInGithubUser(db, github(2, "imposter", "ada@example.com"));
    expect(second.id).not.toBe(first.id);
    expect(second.email).toBeNull();
    expect((await signInGithubUser(db, github(1, "ada-gh"))).githubId).toBe(1);
  });

  test("a user with no email gets the verified one on their next sign-in", async () => {
    const db = testDb();
    const before = await signInGithubUser(db, github(1, "ada-gh"));
    const after = await signInGithubUser(db, github(1, "ada-gh", "ada@example.com"));
    expect(after.id).toBe(before.id);
    expect(after.email).toBe("ada@example.com");
  });
});

describe("invites by email or GitHub login", () => {
  test("an email invite becomes a membership on a Google sign-in", async () => {
    const db = testDb();
    const owner = await signInGithubUser(db, github(1, "owner"));
    const org = await createOrg(db, owner.id, "Acme");
    await inviteMember(db, owner, org.id, " Ada@Example.com ");
    expect((await listOrgs(db, owner.id))[0]?.invites).toEqual([
      expect.objectContaining({ githubLogin: null, email: "ada@example.com" }),
    ]);

    const ada = await signInGoogleUser(db, google("g-1", "ada@example.com"));
    expect((await listOrgs(db, ada.id)).map((o) => o.id)).toEqual([org.id]);
    expect((await listOrgs(db, owner.id))[0]?.invites).toEqual([]);
  });

  test("an email invite also matches a GitHub sign-in with that verified email", async () => {
    const db = testDb();
    const owner = await signInGithubUser(db, github(1, "owner"));
    const org = await createOrg(db, owner.id, "Acme");
    await inviteMember(db, owner, org.id, "ada@example.com");
    const ada = await signInGithubUser(db, github(2, "ada-gh", "ada@example.com"));
    expect((await listOrgs(db, ada.id)).map((o) => o.id)).toEqual([org.id]);
  });

  test("a login invite still works for GitHub, and never for a Google user with that handle", async () => {
    const db = testDb();
    const owner = await signInGithubUser(db, github(1, "owner"));
    const org = await createOrg(db, owner.id, "Acme");
    await inviteMember(db, owner, org.id, "Carol");
    expect((await listOrgs(db, owner.id))[0]?.invites).toEqual([
      expect.objectContaining({ githubLogin: "carol", email: null }),
    ]);

    const g = await signInGoogleUser(db, google("g-9", "carol@example.com"));
    expect(await listOrgs(db, g.id)).toEqual([]);
    const carol = await signInGithubUser(db, github(3, "carol"));
    expect((await listOrgs(db, carol.id)).map((o) => o.id)).toEqual([org.id]);
  });
});
