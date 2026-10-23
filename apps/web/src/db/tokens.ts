import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { randomToken, sha256Hex } from "#/lib/crypto";
import { type Db, NotFoundError } from "./db";
import { getProject, requireMember } from "./orgs";
import { ciTokens, members, projects, userTokens } from "./schema";
import { orgTokens } from "./schema-org-tokens";

const PREFIX = "psci_";

/** The plaintext is returned here and nowhere else; the table keeps its hash. */
export async function issueCiToken(db: Db, userId: string, projectId: string, name: string) {
  await getProject(db, userId, projectId);
  const token = randomToken(PREFIX);
  const id = crypto.randomUUID();
  await db.insert(ciTokens).values({
    id,
    projectId,
    name,
    tokenHash: await sha256Hex(token),
    prefix: token.slice(0, PREFIX.length + 4),
    createdBy: userId,
  });
  return { id, token };
}

/** For the settings page: never the hash. */
export async function listCiTokens(db: Db, userId: string, projectId: string) {
  await getProject(db, userId, projectId);
  return db
    .select({
      id: ciTokens.id,
      name: ciTokens.name,
      prefix: ciTokens.prefix,
      createdAt: ciTokens.createdAt,
      lastUsedAt: ciTokens.lastUsedAt,
      revokedAt: ciTokens.revokedAt,
    })
    .from(ciTokens)
    .where(eq(ciTokens.projectId, projectId))
    .orderBy(desc(ciTokens.createdAt));
}

export async function revokeCiToken(db: Db, userId: string, tokenId: string): Promise<void> {
  const [row] = await db
    .select({ projectId: ciTokens.projectId })
    .from(ciTokens)
    .where(eq(ciTokens.id, tokenId));
  if (!row) throw new NotFoundError("token");
  await getProject(db, userId, row.projectId);
  await db
    .update(ciTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(ciTokens.id, tokenId), isNull(ciTokens.revokedAt)));
}

/** What CI authenticates with: the project a live token belongs to, or null. */
export async function verifyCiToken(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .select({ tokenId: ciTokens.id, projectId: projects.id, orgId: projects.orgId })
    .from(ciTokens)
    .innerJoin(projects, eq(projects.id, ciTokens.projectId))
    .where(and(eq(ciTokens.tokenHash, await sha256Hex(token)), isNull(ciTokens.revokedAt)));
  if (!row) return null;
  await db.update(ciTokens).set({ lastUsedAt: now }).where(eq(ciTokens.id, row.tokenId));
  return { projectId: row.projectId, orgId: row.orgId };
}

const ORG_PREFIX = "psorg_";

/** An org CI token (ob 1787): any member may issue one. The plaintext is returned here and nowhere else. */
export async function issueOrgToken(db: Db, userId: string, orgId: string, name: string) {
  await requireMember(db, userId, orgId);
  const token = randomToken(ORG_PREFIX);
  const id = crypto.randomUUID();
  await db.insert(orgTokens).values({
    id,
    orgId,
    name,
    tokenHash: await sha256Hex(token),
    prefix: token.slice(0, ORG_PREFIX.length + 4),
    createdBy: userId,
  });
  return { id, token };
}

/** The org tokens of every org the user belongs to, for the organizations page: never the hash. */
export async function listOrgTokens(db: Db, userId: string) {
  const orgIds = db
    .select({ orgId: members.orgId })
    .from(members)
    .where(eq(members.userId, userId));
  return db
    .select({
      id: orgTokens.id,
      orgId: orgTokens.orgId,
      name: orgTokens.name,
      prefix: orgTokens.prefix,
      createdAt: orgTokens.createdAt,
      lastUsedAt: orgTokens.lastUsedAt,
      revokedAt: orgTokens.revokedAt,
    })
    .from(orgTokens)
    .where(inArray(orgTokens.orgId, orgIds))
    .orderBy(desc(orgTokens.createdAt), desc(orgTokens.id));
}

/** Another org's token is the same 404 as a missing one. */
export async function revokeOrgToken(db: Db, userId: string, tokenId: string): Promise<void> {
  const [row] = await db
    .select({ id: orgTokens.id })
    .from(orgTokens)
    .innerJoin(members, and(eq(members.orgId, orgTokens.orgId), eq(members.userId, userId)))
    .where(eq(orgTokens.id, tokenId));
  if (!row) throw new NotFoundError("token");
  await db
    .update(orgTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(orgTokens.id, tokenId), isNull(orgTokens.revokedAt)));
}

/** What CI authenticates with when it names its project: the org a live org token belongs to, or null. */
export async function verifyOrgToken(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .select({ tokenId: orgTokens.id, orgId: orgTokens.orgId })
    .from(orgTokens)
    .where(and(eq(orgTokens.tokenHash, await sha256Hex(token)), isNull(orgTokens.revokedAt)));
  if (!row) return null;
  await db.update(orgTokens).set({ lastUsedAt: now }).where(eq(orgTokens.id, row.tokenId));
  return { orgId: row.orgId };
}

const USER_PREFIX = "psu_";

/** A personal token (ob 1728). The plaintext is returned here and nowhere else; `expiresAt` null never expires. */
export async function issueUserToken(db: Db, userId: string, name: string, expiresAt: Date | null) {
  const token = randomToken(USER_PREFIX);
  const id = crypto.randomUUID();
  await db.insert(userTokens).values({
    id,
    userId,
    name,
    hash: await sha256Hex(token),
    prefix: token.slice(0, USER_PREFIX.length + 4),
    expiresAt,
  });
  return { id, token };
}

/** The user's own tokens for the settings page: never the hash. */
export async function listUserTokens(db: Db, userId: string) {
  return db
    .select({
      id: userTokens.id,
      name: userTokens.name,
      prefix: userTokens.prefix,
      createdAt: userTokens.createdAt,
      lastUsedAt: userTokens.lastUsedAt,
      expiresAt: userTokens.expiresAt,
      revokedAt: userTokens.revokedAt,
    })
    .from(userTokens)
    .where(eq(userTokens.userId, userId))
    .orderBy(desc(userTokens.createdAt));
}

/** Another user's token is the same 404 as a missing one. */
export async function revokeUserToken(db: Db, userId: string, tokenId: string): Promise<void> {
  const mine = and(eq(userTokens.id, tokenId), eq(userTokens.userId, userId));
  const [row] = await db.select({ id: userTokens.id }).from(userTokens).where(mine);
  if (!row) throw new NotFoundError("token");
  await db
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(and(mine, isNull(userTokens.revokedAt)));
}

/** What the CLI and MCP authenticate with: the user a live, unexpired token belongs to, or null. */
export async function verifyUserToken(db: Db, token: string, now = new Date()) {
  const [row] = await db
    .select({ tokenId: userTokens.id, userId: userTokens.userId })
    .from(userTokens)
    .where(
      and(
        eq(userTokens.hash, await sha256Hex(token)),
        isNull(userTokens.revokedAt),
        or(isNull(userTokens.expiresAt), gt(userTokens.expiresAt, now)),
      ),
    );
  if (!row) return null;
  await db.update(userTokens).set({ lastUsedAt: now }).where(eq(userTokens.id, row.tokenId));
  return { userId: row.userId };
}
