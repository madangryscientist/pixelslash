import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { randomToken, sha256Hex } from "#/lib/crypto";
import { type Db, NotFoundError } from "./db";
import { getProject } from "./orgs";
import { ciTokens, projects, userTokens } from "./schema";

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
