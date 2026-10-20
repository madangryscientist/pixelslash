import { describe, expect, test } from "vitest";
import { SIGNED_URL_TTL_MS, signedImagePath, verifySignedImagePath } from "./signed";

const KEY = "orgs/o1/builds/b1/abc.png";
const SECRET = "test-secret";
const NOW = 1_700_000_000_000;

function parts(path: string) {
  const url = new URL(path, "http://localhost");
  return {
    key: url.pathname.replace(/^\/images\//, ""),
    exp: url.searchParams.get("exp"),
    sig: url.searchParams.get("sig"),
  };
}

describe("signed image URLs", () => {
  test("a fresh URL names the key and verifies", async () => {
    const path = await signedImagePath(KEY, SECRET, NOW);
    const { key, exp, sig } = parts(path);
    expect(path.startsWith(`/images/${KEY}?exp=`)).toBe(true);
    expect(Number(exp)).toBe(NOW + SIGNED_URL_TTL_MS);
    expect(await verifySignedImagePath({ key, expires: exp, sig, secret: SECRET, now: NOW })).toBe(
      true,
    );
  });

  test("an expired URL, a tampered key and a wrong secret all fail", async () => {
    const { key, exp, sig } = parts(await signedImagePath(KEY, SECRET, NOW));
    const check = (over: Partial<Parameters<typeof verifySignedImagePath>[0]>) =>
      verifySignedImagePath({ key, expires: exp, sig, secret: SECRET, now: NOW, ...over });
    expect(await check({ now: NOW + SIGNED_URL_TTL_MS })).toBe(false);
    expect(await check({ key: "orgs/o2/builds/b1/abc.png" })).toBe(false);
    expect(await check({ secret: "other-secret" })).toBe(false);
    expect(await check({ expires: null })).toBe(false);
    expect(await check({ sig: null })).toBe(false);
    expect(await check({ expires: "not-a-number" })).toBe(false);
  });
});
