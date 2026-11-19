import { describe, expect, test } from "vitest";
import { movedTo } from "./moved";

const at = (href: string, method = "GET") => movedTo(new URL(href), method);
const HOSTS = ["https://pixelslash.dev", "https://app.pixelslash.dev"];

describe("movedTo", () => {
  test("sends the old site's pages to slashslash.build on either host, query kept", () => {
    for (const host of HOSTS) {
      for (const page of ["/how-it-works", "/compare", "/pricing", "/security", "/self-host"]) {
        const to = `https://slashslash.build/pixelslash${page}`;
        expect(at(`${host}${page}`)).toBe(to);
        expect(at(`${host}${page}/`)).toBe(to);
        expect(at(`${host}${page}?ref=x`)).toBe(`${to}?ref=x`);
        expect(at(`${host}${page}`, "HEAD")).toBe(to);
      }
    }
  });

  test("sends the docs, each doc, the search index and the sitemap", () => {
    for (const host of HOSTS) {
      expect(at(`${host}/docs`)).toBe("https://slashslash.build/pixelslash/docs");
      expect(at(`${host}/docs/`)).toBe("https://slashslash.build/pixelslash/docs");
      expect(at(`${host}/docs/upload`)).toBe("https://slashslash.build/pixelslash/docs/upload");
      expect(at(`${host}/docs/upload/?a=1`)).toBe(
        "https://slashslash.build/pixelslash/docs/upload?a=1",
      );
      expect(at(`${host}/search-index.json`)).toBe(
        "https://slashslash.build/pixelslash/search-index.json",
      );
      expect(at(`${host}/sitemap.xml`)).toBe("https://slashslash.build/sitemap.xml");
    }
  });

  test("sends a page view on the old app host to the same path on pixelslash.dev", () => {
    expect(at("https://app.pixelslash.dev/orgs?x=1")).toBe("https://pixelslash.dev/orgs?x=1");
    expect(at("https://app.pixelslash.dev/")).toBe("https://pixelslash.dev/");
    expect(at("https://app.pixelslash.dev/projects/a/builds/b")).toBe(
      "https://pixelslash.dev/projects/a/builds/b",
    );
  });

  test("leaves the API, sign-in and signed images on the old host", () => {
    expect(at("https://app.pixelslash.dev/api/v1/builds")).toBeNull();
    expect(at("https://app.pixelslash.dev/auth/github/callback?code=c&state=s")).toBeNull();
    expect(at("https://app.pixelslash.dev/auth/google/callback")).toBeNull();
    expect(at("https://app.pixelslash.dev/images/abc.png?sig=1")).toBeNull();
  });

  test("never redirects a POST, the apex's own pages, or any other host", () => {
    for (const host of HOSTS) {
      expect(at(`${host}/api/v1/builds`, "POST")).toBeNull();
      expect(at(`${host}/docs`, "POST")).toBeNull();
      expect(at(`${host}/orgs`, "PUT")).toBeNull();
    }
    expect(at("https://app.pixelslash.dev/orgs", "POST")).toBeNull();
    expect(at("https://pixelslash.dev/")).toBeNull();
    expect(at("https://pixelslash.dev/orgs?x=1")).toBeNull();
    expect(at("https://pixelslash.dev/docs/a/b")).toBeNull();
    expect(at("http://192.168.0.10:8787/docs")).toBeNull();
    expect(at("http://192.168.0.10:8787/orgs")).toBeNull();
    expect(at("http://localhost:3000/security")).toBeNull();
  });
});
