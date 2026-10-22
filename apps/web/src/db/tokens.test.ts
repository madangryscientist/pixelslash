import { describe, expect, test } from "vitest";
import { sha256Hex } from "#/lib/crypto";
import { NotFoundError } from "./db";
import { createOrg, createProject } from "./orgs";
import { ciTokens, userTokens } from "./schema";
import { testDb } from "./test-db";
import {
  issueCiToken,
  issueUserToken,
  listCiTokens,
  listUserTokens,
  revokeCiToken,
  revokeUserToken,
  verifyCiToken,
  verifyUserToken,
} from "./tokens";
import { signInGithubUser } from "./users";

async function setup() {
  const db = testDb();
  const user = await signInGithubUser(db, {
    githubId: 1,
    login: "ada",
    name: null,
    avatarUrl: null,
  });
  const org = await createOrg(db, user.id, "Acme");
  const project = await createProject(db, user.id, org.id, "web");
  return { db, user, org, project };
}

describe("CI tokens", () => {
  test("the plaintext is returned once and only its hash is stored", async () => {
    const { db, user, project } = await setup();
    const { token } = await issueCiToken(db, user.id, project.id, "github-actions");

    expect(token).toMatch(/^psci_[\w-]{43}$/);
    const [row] = await db.select().from(ciTokens);
    expect(row?.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token.slice(5));
    const listed = await listCiTokens(db, user.id, project.id);
    expect(listed).toEqual([
      expect.objectContaining({ name: "github-actions", prefix: token.slice(0, 9) }),
    ]);
    expect(listed[0]).not.toHaveProperty("tokenHash");
  });

  test("a live token resolves to its project; a revoked or unknown one does not", async () => {
    const { db, user, org, project } = await setup();
    const { id, token } = await issueCiToken(db, user.id, project.id, "ci");

    expect(await verifyCiToken(db, token)).toEqual({ projectId: project.id, orgId: org.id });
    expect(await verifyCiToken(db, `${token}x`)).toBeNull();

    await revokeCiToken(db, user.id, id);
    expect(await verifyCiToken(db, token)).toBeNull();
    const [listed] = await listCiTokens(db, user.id, project.id);
    expect(listed?.revokedAt).toBeInstanceOf(Date);
    expect(listed?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("another org's member cannot revoke a token", async () => {
    const { db, user, project } = await setup();
    const { id, token } = await issueCiToken(db, user.id, project.id, "ci");
    const outsider = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });

    await expect(revokeCiToken(db, outsider.id, id)).rejects.toThrow(NotFoundError);
    expect(await verifyCiToken(db, token)).not.toBeNull();
  });
});

describe("personal tokens", () => {
  test("the plaintext is returned once and only its hash is stored", async () => {
    const { db, user } = await setup();
    const { token } = await issueUserToken(db, user.id, "laptop", null);

    expect(token).toMatch(/^psu_[\w-]{43}$/);
    const [row] = await db.select().from(userTokens);
    expect(row?.hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
    const listed = await listUserTokens(db, user.id);
    expect(listed).toEqual([
      expect.objectContaining({ name: "laptop", prefix: token.slice(0, 8), expiresAt: null }),
    ]);
    expect(listed[0]).not.toHaveProperty("hash");
  });

  test("a live token resolves to its user and records the use; a revoked one does not", async () => {
    const { db, user } = await setup();
    const { id, token } = await issueUserToken(db, user.id, "laptop", null);
    expect((await listUserTokens(db, user.id))[0]?.lastUsedAt).toBeNull();

    const used = new Date("2026-10-22T10:00:00Z");
    expect(await verifyUserToken(db, token, used)).toEqual({ userId: user.id });
    expect((await listUserTokens(db, user.id))[0]?.lastUsedAt).toEqual(used);
    expect(await verifyUserToken(db, `${token}x`)).toBeNull();
    // A CI token is not a personal one, nor the other way round.
    expect(await verifyCiToken(db, token)).toBeNull();

    await revokeUserToken(db, user.id, id);
    expect(await verifyUserToken(db, token)).toBeNull();
    expect((await listUserTokens(db, user.id))[0]?.revokedAt).toBeInstanceOf(Date);
  });

  test("an expired token is refused", async () => {
    const { db, user } = await setup();
    const expiresAt = new Date("2026-11-01T00:00:00Z");
    const { token } = await issueUserToken(db, user.id, "short", expiresAt);

    expect(await verifyUserToken(db, token, new Date("2026-10-31T23:59:59Z"))).not.toBeNull();
    expect(await verifyUserToken(db, token, expiresAt)).toBeNull();
  });

  test("a user sees and revokes only their own tokens", async () => {
    const { db, user } = await setup();
    const { id, token } = await issueUserToken(db, user.id, "laptop", null);
    const eve = await signInGithubUser(db, {
      githubId: 2,
      login: "eve",
      name: null,
      avatarUrl: null,
    });

    expect(await listUserTokens(db, eve.id)).toEqual([]);
    await expect(revokeUserToken(db, eve.id, id)).rejects.toThrow(NotFoundError);
    expect(await verifyUserToken(db, token)).not.toBeNull();
  });
});
