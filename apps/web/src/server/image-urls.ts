import { signedImagePath } from "#/storage/signed";
import { imageSigningSecret } from "./env";

/**
 * Images are only ever handed out as signed, short-lived URLs (invariant 5). Snapshot rows hold
 * keys inside the org's prefix; the URL carries the full blob key, so the route needs no database.
 */
export async function imageUrls(
  orgId: string,
  keys: {
    main: string | null;
    branch: string | null;
    diff: string | null;
  },
): Promise<{ main: string | null; branch: string | null; diff: string | null }> {
  const secret = imageSigningSecret();
  const sign = (key: string | null) =>
    key ? signedImagePath(`orgs/${orgId}/${key}`, secret) : null;
  return {
    main: await sign(keys.main),
    branch: await sign(keys.branch),
    diff: await sign(keys.diff),
  };
}
