import { describe, expect, test } from "vitest";
import { sha256Hex } from "#/lib/crypto";
import { NotFoundError } from "./db";
import { createOrg, createProject } from "./orgs";
import { ciTokens } from "./schema";
import { testDb } from "./test-db";
import { issueCiToken, listCiTokens, revokeCiToken, verifyCiToken } from "./tokens";
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
