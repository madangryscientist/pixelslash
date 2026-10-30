import { createServerFn } from "@tanstack/react-start";
import { issueOrgToken, revokeOrgToken } from "#/db/tokens";
import { database } from "./env";
import { field, or404 } from "./input";
import { requireViewer } from "./session";

/** An org token (ob 1787): any member mints one for the org; the plaintext is returned once. */
export const issueOrgTokenFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ orgId: field(d, "orgId"), name: field(d, "name") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    return or404(issueOrgToken(database(), user.id, data.orgId, data.name));
  });

export const revokeOrgTokenFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ tokenId: field(d, "tokenId") }))
  .handler(async ({ data }) => {
    const user = await requireViewer();
    await or404(revokeOrgToken(database(), user.id, data.tokenId));
  });
