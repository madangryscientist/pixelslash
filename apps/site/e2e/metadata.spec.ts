import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { LISTED_PAGES } from "../src/content/docs-map.ts";
import { MOVED, REDIRECTS } from "../src/content/moved.ts";
import { PAGES } from "../src/content/pages.ts";

/*
 * What a search engine and a link preview read: a title and a description of its own on every page,
 * a canonical URL that is the page's own address with no redirect, the social card, the sitemap.
 */

const ORIGIN = "https://pixelslash.dev";
const PATHS = [
  ...PAGES.map((page) => page.to),
  ...LISTED_PAGES.map((page) => `/docs/${page.slug}`),
];

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
  expect(PAGES.map((one) => one.to)).toEqual(["/docs", "/self-host", "/security"]);
  for (const moved of MOVED) {
    expect(locs, `${moved.from} moved to slashslash.build`).not.toContain(`${ORIGIN}${moved.from}`);
  }

  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  expect(robots).not.toMatch(/^Disallow: \/$/m);
});

test("a page with a trailing slash redirects to the canonical one", async ({ page }) => {
  const response = await page.request.get("/security/", { maxRedirects: 0 });
  expect(response.status()).toBeGreaterThanOrEqual(300);
  expect(response.status()).toBeLessThan(400);
  expect(response.headers()["location"]).toBe("/security");
});

/*
 * The marketing pages moved to slashslash.build: each old path, with and without its trailing
 * slash, answers a 301 to its new address, from the site's own Worker entry (src/server.ts).
 */
test("each moved page answers a 301 to its slashslash.build address", async ({ page }) => {
  // `/` has no trailing-slash form of its own, so the other three give two paths each.
  const moved: [string, string][] = [
    ["/", "https://slashslash.build/pixelslash"],
    ["/how-it-works", "https://slashslash.build/pixelslash/how-it-works"],
    ["/how-it-works/", "https://slashslash.build/pixelslash/how-it-works"],
    ["/compare", "https://slashslash.build/pixelslash/compare"],
    ["/compare/", "https://slashslash.build/pixelslash/compare"],
    ["/pricing", "https://slashslash.build/pixelslash/pricing"],
    ["/pricing/", "https://slashslash.build/pixelslash/pricing"],
  ];
  expect([...REDIRECTS]).toEqual(moved);
  for (const [path, location] of moved) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(301);
    expect(response.headers()["location"], path).toBe(location);
  }
});

// The built files themselves, every page the prerender wrote: scripts/check-commit.ts reads this meta after a deploy.
test("every prerendered page names the commit it was built from, in its head only", () => {
  const dist = new URL("../dist/client/", import.meta.url);
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".html"),
  );
  expect(files.length).toBeGreaterThanOrEqual(PATHS.length);
  for (const file of files) {
    const html = readFileSync(new URL(file, dist), "utf8");
    const end = html.indexOf("</head>");
    expect(end, file).toBeGreaterThan(0);
    const head = html.slice(0, end);
    const metas = [...html.matchAll(/<meta\s[^>]*>/g)].filter(
      (match) => attr(match[0], "name") === "build-commit",
    );
    expect(metas, file).toHaveLength(1);
    const [tag = ""] = metas.map((match) => match[0]);
    expect(head, file).toContain(tag);
    expect(attr(tag, "content"), file).toMatch(/^([0-9a-f]{40}(-dirty)?|unknown)$/);
  }
});
