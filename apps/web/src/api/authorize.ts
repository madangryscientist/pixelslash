import type { Actor } from "#/db/actor";
import type { Db } from "#/db/db";
import { verifyCiToken, verifyUserToken } from "#/db/tokens";

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * The one place `/api/v1` reads a token (ob 1728). A `psu_` token acts as its user, any other as a
 * CI token for its project; null is a 401. No endpoint checks a token itself: each takes the actor
 * and reaches rows only through `db/actor.ts`.
 */
export async function authorize(ctx: { db: Db; request: Request }): Promise<Actor | null> {
  const token = bearer(ctx.request);
  if (!token) return null;
  if (token.startsWith("psu_")) {
    const user = await verifyUserToken(ctx.db, token);
    return user && { kind: "user", userId: user.userId };
  }
  const ci = await verifyCiToken(ctx.db, token);
  return ci && { kind: "ci", projectId: ci.projectId };
}
