/**
 * Short-lived signed image URLs (ob 1421, invariant 4). The blob store is private: a page never
 * links an R2 object directly, it links `/images/<key>?exp=…&sig=…`, and the route serves the
 * object only while the expiry holds and the HMAC matches. A leaked page therefore leaks a URL
 * that is useless in minutes, not a bucket that is public forever.
 */

/** Long enough to load a page and its thumbnails, short enough that a copied URL goes stale. */
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  const raw = String.fromCharCode(...bytes);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/** What is signed: the expiry and the key together, so neither can be swapped for another. */
function payload(expires: number, key: string): string {
  return `${expires}:${key}`;
}

/** `/images/<key>?exp=…&sig=…`; `key` is an org-scoped blob key such as `orgs/o/builds/b/x.png`. */
export async function signedImagePath(
  key: string,
  secret: string,
  now = Date.now(),
): Promise<string> {
  const expires = now + SIGNED_URL_TTL_MS;
  const sig = await hmac(secret, payload(expires, key));
  return `/images/${key}?exp=${expires}&sig=${sig}`;
}

/** True only for an unexpired signature over exactly this key. */
export async function verifySignedImagePath(input: {
  key: string;
  expires: string | null;
  sig: string | null;
  secret: string;
  now?: number;
}): Promise<boolean> {
  const { key, expires, sig, secret, now = Date.now() } = input;
  if (!expires || !sig) return false;
  const at = Number(expires);
  if (!Number.isSafeInteger(at) || at <= now) return false;
  const expected = await hmac(secret, payload(at, key));
  // Length-check first: timingSafeEqual-style comparisons need equal lengths.
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}
