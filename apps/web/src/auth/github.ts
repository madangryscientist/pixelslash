import type { GithubProfile } from "#/db/users";

/** The bases are config so the e2e build can sign in against a local stub instead of GitHub. */
export type GithubConfig = {
  clientId: string;
  clientSecret: string;
  oauthBase: string;
  apiBase: string;
};

export function authorizeUrl(cfg: GithubConfig, state: string, redirectUri: string): string {
  const url = new URL("/login/oauth/authorize", cfg.oauthBase);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    state,
    scope: "read:user user:email",
    allow_signup: "true",
  }).toString();
  return url.toString();
}

/** Trade the callback's code for a token, then read the signed-in user's profile and verified email. */
export async function fetchGithubProfile(
  cfg: GithubConfig,
  code: string,
  redirectUri: string,
): Promise<GithubProfile> {
  const tokenRes = await fetch(new URL("/login/oauth/access_token", cfg.oauthBase), {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token: unknown = await tokenRes.json();
  if (!isRecord(token) || typeof token["access_token"] !== "string")
    throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token["access_token"]}`,
    "user-agent": "pixelslash",
  };
  const userRes = await fetch(new URL("/user", cfg.apiBase), { headers });
  const emailsRes = await fetch(new URL("/user/emails", cfg.apiBase), { headers });
  // No email is no link to a Google sign-in, not a failed sign-in (PS-274).
  const email = emailsRes.ok ? primaryVerifiedEmail(await emailsRes.json()) : null;
  return { ...toProfile(await userRes.json()), email };
}

/** The primary address, and only when GitHub has verified it; lowercased. */
export function primaryVerifiedEmail(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  const primary = body.find(
    (e: unknown) => isRecord(e) && e["primary"] === true && e["verified"] === true,
  );
  return isRecord(primary) && typeof primary["email"] === "string"
    ? primary["email"].toLowerCase()
    : null;
}

function toProfile(body: unknown): GithubProfile {
  if (!isRecord(body) || typeof body["id"] !== "number" || typeof body["login"] !== "string")
    throw new Error("GitHub /user returned no id and login");
  return {
    githubId: body["id"],
    login: body["login"],
    name: typeof body["name"] === "string" ? body["name"] : null,
    avatarUrl: typeof body["avatar_url"] === "string" ? body["avatar_url"] : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
