import type { Actor } from "#/db/actor";
import type { Db } from "#/db/db";
import { verifyCiToken, verifyOrgToken, verifyUserToken } from "#/db/tokens";

/** The request's `Authorization: Bearer` token, or null. */
export function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * The one place `/api/v1` reads a token (ob 1728). A `psu_` token acts as its user, a `psorg_` token
 * as its org's CI (ob 1787), any other as a CI token for its project; null is a 401. No endpoint checks a token itself: each takes the actor
 * and reaches rows only through `db/actor.ts`.
 */
export async function authorize(ctx: { db: Db; request: Request }): Promise<Actor | null> {
  const token = bearer(ctx.request);
  if (!token) return null;
  if (token.startsWith("psu_")) {
    const user = await verifyUserToken(ctx.db, token);
    return user && { kind: "user", userId: user.userId };
  }
  if (token.startsWith("psorg_")) {
    const org = await verifyOrgToken(ctx.db, token);
    return org && { kind: "org-ci", orgId: org.orgId };
  }
  const ci = await verifyCiToken(ctx.db, token);
  return ci && { kind: "ci", projectId: ci.projectId };
}
