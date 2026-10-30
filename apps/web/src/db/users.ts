import { type SQL, and, eq, gt, or } from "drizzle-orm";
import { randomToken, sha256Hex } from "#/lib/crypto";
import { chunk } from "./chunks";
import type { Db } from "./db";
import { members, sessions, users } from "./schema";
import { invites } from "./schema-invites";

export type GithubProfile = {
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** The primary email, only when GitHub has verified it; lowercased. */
  email?: string | null;
};

/** A Google sign-in's account; `email` is verified and lowercased (`src/auth/google.ts`). */
export type GoogleProfile = {
  sub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type User = typeof users.$inferSelect;

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The user a sign-in is (PS-274): found by the provider's subject, else by the verified email when
 * that user has no account of this provider yet, else null (create one). An email only ever reaches
 * here verified, so an unverified one never links two accounts, and a user already holding another
 * account of the same provider is never taken over by a second one that claims the email.
 */
async function findUser(
  db: Db,
  subject: SQL,
  email: string | null,
  linkable: (user: User) => boolean,
): Promise<User | null> {
  const [own] = await db.select().from(users).where(subject);
  if (own) return own;
  if (!email) return null;
  const [linked] = await db.select().from(users).where(eq(users.email, email));
  return linked && linkable(linked) ? linked : null;
}

/** The email, unless another user already holds it. */
async function freeEmail(db: Db, email: string | null): Promise<string | null> {
  if (!email) return null;
  const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return taken ? null : email;
}

/** Record a newly verified email on a user who has none, unless another user already has it. */
const emailIfFree = async (db: Db, user: User, email: string | null): Promise<string | null> =>
  user.email ?? (await freeEmail(db, email));

/** A Google sign-in whose email another user holds with a different Google account. */
export class EmailInUseError extends Error {}

async function save(db: Db, id: string, set: Partial<User>): Promise<User> {
  const [user] = await db.update(users).set(set).where(eq(users.id, id)).returning();
  if (!user) throw new Error("user update returned nothing");
  return user;
}

/** Create or refresh the user for a GitHub sign-in, and turn their pending invites into memberships. */
export async function signInGithubUser(db: Db, profile: GithubProfile): Promise<User> {
  const { githubId, login, name, avatarUrl, email = null } = profile;
  const found = await findUser(db, eq(users.githubId, githubId), email, (u) => u.githubId === null);
  const user = found
    ? await save(db, found.id, {
        githubId,
        login,
        name,
        avatarUrl,
        email: await emailIfFree(db, found, email),
      })
    : await insert(db, { githubId, login, name, avatarUrl, email: await freeEmail(db, email) });
  await acceptInvites(db, user);
  return user;
}

/**
 * Create or refresh the user for a Google sign-in. A user with no GitHub identity is shown by their
 * email (`login`); one who has GitHub keeps their GitHub login, name and avatar.
 */
export async function signInGoogleUser(db: Db, profile: GoogleProfile): Promise<User> {
  const found = await findUser(
    db,
    eq(users.googleSub, profile.sub),
    profile.email,
    (u) => u.googleSub === null,
  );
  let user: User;
  if (!found) {
    // A Google-only user is shown by their email, so it must be theirs alone.
    if (!(await freeEmail(db, profile.email)))
      throw new EmailInUseError("Another PixelSlash account already uses this email address.");
    user = await insert(db, {
      googleSub: profile.sub,
      email: profile.email,
      login: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
  } else
    user = await save(db, found.id, {
      googleSub: profile.sub,
      email: await emailIfFree(db, found, profile.email),
      name: found.name ?? profile.name,
      avatarUrl: found.avatarUrl ?? profile.avatarUrl,
    });
  await acceptInvites(db, user);
  return user;
}

async function insert(db: Db, values: Omit<typeof users.$inferInsert, "id">): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), ...values })
    .returning();
  if (!user) throw new Error("user insert returned nothing");
  return user;
}

/** Every pending invite naming the user's GitHub login or verified email becomes a membership. */
async function acceptInvites(db: Db, user: User): Promise<void> {
  const names = [
    user.githubId === null ? undefined : eq(invites.githubLogin, user.login.toLowerCase()),
    user.email ? eq(invites.email, user.email) : undefined,
  ].filter((c) => c !== undefined);
  if (names.length === 0) return;
  const matching = or(...names);
  const pending = await db.select().from(invites).where(matching);
  if (pending.length === 0) return;
  // Two parameters a row; `createdAt` is a column default, not bound.
  for (const part of chunk(pending, 0, 2))
    await db
      .insert(members)
      .values(part.map((i) => ({ orgId: i.orgId, userId: user.id })))
      .onConflictDoNothing();
  await db.delete(invites).where(matching);
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
