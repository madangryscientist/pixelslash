import { and, desc, eq, isNull } from "drizzle-orm";
import { randomToken, sha256Hex } from "#/lib/crypto";
import { type Db, NotFoundError } from "./db";
import { getProject } from "./orgs";
import { ciTokens, projects } from "./schema";

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
