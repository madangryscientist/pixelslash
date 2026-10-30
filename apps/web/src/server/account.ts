import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { issueUserToken, listUserTokens, revokeUserToken } from "#/db/tokens";
import { TOKEN_EXPIRY_DAYS } from "#/lib/token-expiry";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/* The signed-in user's own settings: personal API tokens (ob 1728). */

function expiryDays(input: unknown): number | null {
  const value = typeof input === "object" && input !== null ? Reflect.get(input, "days") : null;
  if (value === null || value === undefined) return null;
  if (!TOKEN_EXPIRY_DAYS.some((days) => days === value))
    throw new Error(`days must be one of ${TOKEN_EXPIRY_DAYS.join(", ")} or never`);
  return Number(value);
}

export const getAccountSettings = createServerFn().handler(async () => {
  const user = await requireViewer();
  const tokens = await listUserTokens(database(), user.id);
  return { tokens, now: new Date(), serverUrl: getRequestUrl().origin };
});

export const issuePersonalToken = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ name: field(d, "name"), days: expiryDays(d) }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    const expiresAt = data.days ? new Date(Date.now() + data.days * 24 * 60 * 60 * 1000) : null;
    return issueUserToken(database(), user.id, data.name, expiresAt);
  });

export const revokePersonalToken = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ tokenId: field(d, "tokenId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(revokeUserToken(database(), user.id, data.tokenId));
  });
