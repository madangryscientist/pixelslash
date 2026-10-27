import { describe, expect, test } from "vitest";
import { type RateLimiter, noRateLimit, rateLimiterOf } from "#/server/rate-limit";
import { call, setup } from "./test-support";

/** `/api/v1` answers 429 `rate_limited` over the limit (PS-250); a deployment without one is never limited. */

/** Lets `allow` requests through per key, then refuses; records the keys it was asked about. */
function counting(allow: number) {
  const seen: string[] = [];
  const limiter: RateLimiter = {
    limit: async ({ key }) => {
      seen.push(key);
      return { success: seen.filter((k) => k === key).length <= allow };
    },
  };
  return { limiter, seen };
}

describe("the API's rate limit", () => {
  test("a token over its limit gets 429 rate_limited with a Retry-After, and another token does not", async () => {
    const { deps, acme, other } = await setup();
    const { limiter, seen } = counting(2);
    const limited = { ...deps, rateLimit: limiter };
    expect((await call(limited, "GET /api/v1/projects", acme.token)).status).toBe(200);
    expect((await call(limited, "GET /api/v1/projects", acme.token)).status).toBe(200);
    const over = await call(limited, "GET /api/v1/projects", acme.token);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(await over.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect((await call(limited, "GET /api/v1/projects", other.token)).status).toBe(200);
    // The counter is keyed by the token's hash, never the token.
    expect(seen.every((k) => k.startsWith("token:") && !k.includes(acme.token))).toBe(true);
  });

  test("an upload endpoint's 429 is the plain-string error it always answers", async () => {
    const { deps, acme } = await setup();
    const res = await call(
      { ...deps, rateLimit: counting(0).limiter },
      "POST /api/v1/builds",
      acme.token,
      "{}",
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many requests: wait a minute and try again" });
  });

  test("a refused token counts against the caller's IP, so made-up tokens are braked too", async () => {
    const { deps } = await setup();
    const { limiter, seen } = counting(1);
    const limited = { ...deps, rateLimit: limiter };
    expect((await call(limited, "GET /api/v1/projects", "made-up-1")).status).toBe(401);
    expect((await call(limited, "GET /api/v1/projects", "made-up-2")).status).toBe(429);
    expect(seen).toEqual(["ip:unknown", "ip:unknown"]);
  });

  test("without a binding every request goes through", async () => {
    expect(rateLimiterOf(undefined)).toBe(noRateLimit);
    const { deps, acme } = await setup();
    for (let i = 0; i < 5; i += 1)
      expect(
        (await call({ ...deps, rateLimit: noRateLimit }, "GET /api/v1/projects", acme.token))
          .status,
      ).toBe(200);
  });
});
