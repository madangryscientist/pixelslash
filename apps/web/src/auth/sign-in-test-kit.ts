import type { RateLimiter } from "#/server/rate-limit";
import type { CookieOptions } from "./sign-in-github";

/** A request to a sign-in route from `ip` (Cloudflare's `cf-connecting-ip`). */
export const request = (path: string, ip = "203.0.113.7"): Request =>
  new Request(new URL(path, "https://app.test"), { headers: { "cf-connecting-ip": ip } });

/** A limiter that lets `allowed` calls per key through, then refuses; it records each key asked. */
export function fakeLimiter(allowed: number): RateLimiter & { keys: string[] } {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return { success: count <= allowed };
    },
  };
}

/** Cookies a request carries, and a record of what the handler set and deleted. */
export function fakeJar(cookies: Record<string, string>) {
  const set: { name: string; value: string; options: CookieOptions }[] = [];
  const deleted: { name: string; options: { path: string } }[] = [];
  return {
    set,
    deleted,
    getCookie: (name: string) => cookies[name],
    setCookie: (name: string, value: string, options: CookieOptions) => {
      set.push({ name, value, options });
    },
    deleteCookie: (name: string, options: { path: string }) => {
      deleted.push({ name, options });
    },
  };
}
