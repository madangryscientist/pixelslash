import { and, eq, gt } from "drizzle-orm";
import { randomToken, sha256Hex } from "#/lib/crypto";
import { chunk } from "./chunks";
import type { Db } from "./db";
import { invites, members, sessions, users } from "./schema";

export type GithubProfile = {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
};

export type User = typeof users.$inferSelect;

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Create or refresh the user for a GitHub sign-in, and turn their pending invites into memberships. */
export async function signInGithubUser(db: Db, profile: GithubProfile): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), ...profile })
    .onConflictDoUpdate({
      target: users.githubId,
      set: { login: profile.login, name: profile.name, avatarUrl: profile.avatarUrl },
    })
    .returning();
  if (!user) throw new Error("user upsert returned nothing");
  await acceptInvites(db, user);
  return user;
}

async function acceptInvites(db: Db, user: User): Promise<void> {
  const login = user.login.toLowerCase();
  const pending = await db.select().from(invites).where(eq(invites.githubLogin, login));
  if (pending.length === 0) return;
  // Two parameters a row; `createdAt` is a column default, not bound.
  for (const part of chunk(pending, 0, 2))
    await db
      .insert(members)
      .values(part.map((i) => ({ orgId: i.orgId, userId: user.id })))
      .onConflictDoNothing();
  await db.delete(invites).where(eq(invites.githubLogin, login));
}

/** Returns the cookie value. Only its hash is stored. */
export async function createSession(db: Db, userId: string, now = new Date()): Promise<string> {
  const token = randomToken("pss_");
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_MS),
  });
  return token;
}

export async function sessionUser(db: Db, token: string, now = new Date()): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await sha256Hex(token)), gt(sessions.expiresAt, now)));
  return row?.user ?? null;
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}
