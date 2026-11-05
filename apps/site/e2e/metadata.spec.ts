import { expect, test } from "@playwright/test";
import { DOC_PAGES } from "../src/content/docs-map.ts";
import { PAGES } from "../src/content/pages.ts";

/*
 * What a search engine and a link preview read: a title and a description of its own on every page,
 * a canonical URL that is the page's own address with no redirect, the social card, the sitemap.
 */

const ORIGIN = "https://pixelslash.dev";
const PATHS = [...PAGES.map((page) => page.to), ...DOC_PAGES.map((page) => `/docs/${page.slug}`)];

const attr = (tag: string, name: string): string =>
  (new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

/** The head as the server sends it, before any script runs. */
async function headOf(
  page: import("@playwright/test").Page,
  path: string,
): Promise<{ title: string; meta: (key: string) => string[]; canonical: string[] }> {
  const response = await page.request.get(path, { maxRedirects: 0 });
  expect(response.status(), path).toBe(200);
  const html = await response.text();
  const head = html.slice(0, html.indexOf("</head>"));
  const tags = [...head.matchAll(/<(?:meta|link)\s[^>]*>/g)].map((match) => match[0]);
  return {
    title: /<title>([^<]*)<\/title>/.exec(head)?.[1] ?? "",
    meta: (key) =>
      tags
        .filter((tag) => attr(tag, "name") === key || attr(tag, "property") === key)
        .map((tag) => attr(tag, "content")),
    canonical: tags
      .filter((tag) => attr(tag, "rel") === "canonical")
      .map((tag) => attr(tag, "href")),
  };
}

test("every page has its own title, description, canonical URL and social card", async ({
  page,
}) => {
  test.slow();
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const path of PATHS) {
    const head = await headOf(page, path);
    expect(head.title, path).toContain("PixelSlash");
    expect(titles.get(head.title), `title of ${path}`).toBeUndefined();
    titles.set(head.title, path);

    const [description = "", ...extra] = head.meta("description");
    expect(extra, `one description on ${path}`).toEqual([]);
    expect(description, path).not.toMatch(/\b(PS|OB)-\d+|\bob \d+|\*\*|\]\(/);
    expect(description.length, `description of ${path}: ${description}`).toBeGreaterThanOrEqual(40);
    expect(description.length, `description of ${path}: ${description}`).toBeLessThanOrEqual(160);
    expect(descriptions.get(description), `description of ${path}`).toBeUndefined();
    descriptions.set(description, path);

    expect(head.canonical, path).toEqual([`${ORIGIN}${path}`]);
    expect(head.meta("og:url"), path).toEqual([`${ORIGIN}${path}`]);
    expect(head.meta("og:title"), path).toEqual([head.title]);
    expect(head.meta("og:description"), path).toEqual([description]);
    expect(head.meta("og:image"), path).toEqual([`${ORIGIN}/social-card.png`]);
    expect(head.meta("og:image:alt")[0], path).toBeTruthy();
    expect(head.meta("twitter:card"), path).toEqual(["summary_large_image"]);
  }
});

test("the social card is a 1200x630 PNG", async ({ page }) => {
  const response = await page.request.get("/social-card.png");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  const png = await response.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("the sitemap lists exactly the site's pages, and robots.txt names it", async ({ page }) => {
  const response = await page.request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("xml");
  const locs = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    (match) => match[1],
  );
  expect(locs).toHaveLength(PATHS.length);
  expect(new Set(locs)).toEqual(new Set(PATHS.map((path) => `${ORIGIN}${path}`)));

  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  expect(robots).not.toMatch(/^Disallow: \/$/m);
});

test("a page with a trailing slash redirects to the canonical one", async ({ page }) => {
  const response = await page.request.get("/pricing/", { maxRedirects: 0 });
  expect(response.status()).toBeGreaterThanOrEqual(300);
  expect(response.status()).toBeLessThan(400);
  expect(response.headers()["location"]).toBe("/pricing");
});
