import type { GoogleProfile } from "#/db/users";

/**
 * Sign in with Google (PS-274): OAuth 2.0 authorization code with PKCE and `state`, then the
 * OpenID userinfo endpoint over the token the code bought. The URLs are config so the e2e build
 * can sign in against a local stub instead of Google.
 */
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
};

const GOOGLE = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
};

/** The Worker's vars; `GOOGLE_CLIENT_SECRET` is a secret (`wrangler secret put`, or `.dev.vars`). */
export type GoogleEnv = {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_BASE?: string;
};

/** Null, Google sign-in off, unless both the client id and secret are set. */
export function googleConfigOf(env: GoogleEnv): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, ...googleEndpoints(env.GOOGLE_OAUTH_BASE?.trim() ?? "") };
}

/** Google's endpoints, or a stand-in's under `base` (the same paths, on one host). */
function googleEndpoints(base: string): Pick<GoogleConfig, keyof typeof GOOGLE> {
  if (!base) return GOOGLE;
  const at = (path: string) => new URL(path, base).toString();
  return {
    authorizeUrl: at("/o/oauth2/v2/auth"),
    tokenUrl: at("/token"),
    userinfoUrl: at("/v1/userinfo"),
  };
}

/** The PKCE S256 challenge for a verifier: base64url of its SHA-256, unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function authorizeUrl(
  cfg: GoogleConfig,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const url = new URL(cfg.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Trade the callback's code (and the PKCE verifier) for a token, then read who signed in. */
export async function fetchGoogleProfile(
  cfg: GoogleConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<GoogleProfile> {
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  const token: unknown = await tokenRes.json();
  if (!isRecord(token) || typeof token["access_token"] !== "string")
    throw new Error(`Google token exchange failed (${tokenRes.status})`);
  const infoRes = await fetch(cfg.userinfoUrl, {
    headers: { accept: "application/json", authorization: `Bearer ${token["access_token"]}` },
  });
  return toProfile(await infoRes.json());
}

/** Only a verified email counts: an unverified one is dropped, and with it the sign-in. */
export function toProfile(body: unknown): GoogleProfile {
  if (!isRecord(body) || typeof body["sub"] !== "string" || !body["sub"])
    throw new Error("Google userinfo returned no subject");
  const email = typeof body["email"] === "string" ? body["email"].toLowerCase() : "";
  if (!email || body["email_verified"] !== true)
    throw new UnverifiedEmailError("Google did not confirm this account's email address.");
  return {
    sub: body["sub"],
    email,
    name: typeof body["name"] === "string" ? body["name"] : null,
    avatarUrl: typeof body["picture"] === "string" ? body["picture"] : null,
  };
}

export class UnverifiedEmailError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
