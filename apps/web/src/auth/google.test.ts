import { describe, expect, test } from "vitest";
import { primaryVerifiedEmail } from "./github";
import {
  UnverifiedEmailError,
  authorizeUrl,
  googleConfigOf,
  pkceChallenge,
  toProfile,
} from "./google";

/** Sign in with Google (PS-274): the parts that decide who signed in, without the network. */

describe("toProfile", () => {
  test("a verified email is kept, lowercased", () => {
    expect(
      toProfile({ sub: "1", email: "Ada@Example.com", email_verified: true, name: "Ada" }),
    ).toEqual({ sub: "1", email: "ada@example.com", name: "Ada", avatarUrl: null });
  });

  test("an unverified or missing email is refused", () => {
    expect(() => toProfile({ sub: "1", email: "ada@example.com", email_verified: false })).toThrow(
      UnverifiedEmailError,
    );
    expect(() => toProfile({ sub: "1", email: "ada@example.com" })).toThrow(UnverifiedEmailError);
    expect(() => toProfile({ sub: "1", email_verified: true })).toThrow(UnverifiedEmailError);
  });

  test("no subject is an error", () => {
    expect(() => toProfile({ email: "a@b.c", email_verified: true })).toThrow(/no subject/);
  });
});

describe("primaryVerifiedEmail", () => {
  test("only the primary, verified email counts", () => {
    expect(
      primaryVerifiedEmail([
        { email: "old@example.com", primary: false, verified: true },
        { email: "Ada@Example.com", primary: true, verified: true },
      ]),
    ).toBe("ada@example.com");
    expect(
      primaryVerifiedEmail([{ email: "ada@example.com", primary: true, verified: false }]),
    ).toBeNull();
    expect(primaryVerifiedEmail({ message: "Not Found" })).toBeNull();
  });
});

describe("googleConfigOf", () => {
  test("off unless both the id and the secret are set", () => {
    expect(googleConfigOf({})).toBeNull();
    expect(googleConfigOf({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" })).toBeNull();
    expect(googleConfigOf({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })).toMatchObject({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
  });

  test("a base points every endpoint at the stand-in", () => {
    const cfg = googleConfigOf({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "s",
      GOOGLE_OAUTH_BASE: "http://localhost:4174",
    });
    expect(cfg?.userinfoUrl).toBe("http://localhost:4174/v1/userinfo");
  });
});

describe("authorizeUrl", () => {
  test("asks for openid email profile with state and an S256 challenge", async () => {
    const cfg = googleConfigOf({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
    if (!cfg) throw new Error("no config");
    const url = new URL(
      await authorizeUrl(cfg, "st", "verifier", "https://x/auth/google/callback"),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "id",
      redirect_uri: "https://x/auth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      state: "st",
      code_challenge: await pkceChallenge("verifier"),
      code_challenge_method: "S256",
    });
  });

  test("the challenge is RFC 7636's example", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
