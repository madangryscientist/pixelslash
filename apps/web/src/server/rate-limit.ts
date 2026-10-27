import { sha256Hex } from "#/lib/crypto";

/**
 * A brake on abuse (PS-250): `/api/v1/*` and sign-in each count requests per key. On Cloudflare the
 * counter is a rate-limit binding (`wrangler.jsonc`'s `ratelimits`); a deployment without one (the
 * self-host, the e2e build, a test) gets `noRateLimit`, which lets every request through.
 */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export const noRateLimit: RateLimiter = { limit: async () => ({ success: true }) };

/** The binding, or the no-op seam when the deployment has none. */
export const rateLimiterOf = (binding: RateLimiter | undefined): RateLimiter =>
  binding ?? noRateLimit;

/** The caller's address as Cloudflare saw it; one shared key when there is none (a local run). */
export const clientIp = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "unknown";

/** A token's key: its hash, so the counter never holds a token. */
export const tokenKey = async (token: string): Promise<string> => `token:${await sha256Hex(token)}`;

export const ipKey = (request: Request): string => `ip:${clientIp(request)}`;

/** True when this request is over the limit for `key`. */
export async function overLimit(limiter: RateLimiter, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return !success;
}

/**
 * Whether an `/api/v1` request is over the limit: counted per accepted token, and per client IP
 * when the token is refused, so a flood of made-up tokens is braked too. No limiter counts none.
 */
export async function overApiLimit(
  limiter: RateLimiter | undefined,
  request: Request,
  acceptedToken: string | null,
): Promise<boolean> {
  if (!limiter) return false;
  return overLimit(limiter, acceptedToken ? await tokenKey(acceptedToken) : ipKey(request));
}

/** A 429's `Retry-After`: Cloudflare's windows are a minute. */
export function retryAfter(res: Response): Response {
  res.headers.set("retry-after", "60");
  return res;
}

/** The sign-in routes' answer when a client is over the limit. */
export const signInLimited = (): Response =>
  new Response("Too many sign-in attempts. Wait a minute and try again.", {
    status: 429,
    headers: { "retry-after": "60" },
  });
