import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DocPage, DocsIndexPage } from "#/components/pages/docs";
import { buildCommandIndex } from "./cli-index.ts";
import { CLI_SPLIT } from "./cli-split.ts";
import { DOC_PAGES, EXTRA_NAV, LISTED_PAGES, findPage, neighbours } from "./docs-map.ts";
import { loadAllDocs } from "./docs.ts";
import { buildSearchIndex } from "./search-index.ts";
import { sitemapXml } from "./sitemap.ts";

/*
 * What the docs map promises a reader: titles that tell pages apart, a way to install Bun before
 * the first command, and an unlisted page that is served but never listed.
 */
const ROOT = join(import.meta.dirname, "../../../..");
// The pages render only once their documents are loaded, as the route loader does first.
await loadAllDocs();
const pageHtml = new Map(
  DOC_PAGES.map((page) => [page.slug, renderToStaticMarkup(<DocPage slug={page.slug} />)]),
);
const indexHtml = renderToStaticMarkup(<DocsIndexPage />);

describe("the nav titles", () => {
  test("no two open with the same two words, once your, own, the and a are dropped", () => {
    const skipped = new Set(["your", "own", "the", "a"]);
    const key = (title: string): string =>
      title
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => !skipped.has(word))
        .slice(0, 2)
        .join(" ");
    const titles = [...LISTED_PAGES.map((page) => page.title), ...EXTRA_NAV.map((x) => x.title)];
    const seen = new Map<string, string[]>();
    for (const title of titles) seen.set(key(title), [...(seen.get(key(title)) ?? []), title]);
    expect([...seen.values()].filter((group) => group.length > 1)).toEqual([]);
  });

  test("the three flaky-shot pages say what they are and all contain 'flaky'", () => {
    expect(findPage("flaky-shots")?.title).toContain("Flaky shots");
    expect(findPage("capture-stabilise")?.title).toContain("Stabilise settings");
    expect(findPage("capture-stabilise")?.title).toContain("flaky");
    expect(findPage("upload-flaky")?.title).toContain("Detecting");
    expect(findPage("upload-flaky")?.title).toContain("flaky");
  });
});

describe("the /docs landing", () => {
  test("links every page the nav lists, the site pages in the nav included", () => {
    const hrefs = [
      ...LISTED_PAGES.map((page) => `/docs/${page.slug}`),
      ...EXTRA_NAV.map((extra) => extra.href),
    ];
    expect(hrefs.filter((href) => !indexHtml.includes(`href="${href}"`))).toEqual([]);
  });

  test("puts a site page in the nav inside its own group's card, after that group's pages", () => {
    for (const extra of EXTRA_NAV) {
      // A group's card is a top-level `<li class="grid ...">`; its links are plain `<li>`s inside it.
      const card = indexHtml
        .split('<li class="grid')
        .find((part) => part.includes(`href="${extra.href}"`));
      expect(card).toBeDefined();
      const group = LISTED_PAGES.filter((page) => page.group === extra.group);
      const last = group.at(-1);
      expect(last).toBeDefined();
      const at = (href: string): number => (card ?? "").indexOf(`href="${href}"`);
      expect(at(`/docs/${last?.slug}`)).toBeGreaterThan(-1);
      expect(at(extra.href)).toBeGreaterThan(at(`/docs/${last?.slug}`));
    }
  });
});

describe("getting started", () => {
  test("shows how to install Bun before its first command", () => {
    const md = readFileSync(join(ROOT, "docs/getting-started.md"), "utf8");
    const bun = md.indexOf("curl -fsSL https://bun.sh/install | bash");
    expect(bun).toBeGreaterThan(-1);
    expect(bun).toBeLessThan(md.indexOf("mkdir my-site"));
    expect(pageHtml.get("getting-started") ?? "").toContain('href="https://bun.sh"');
  });
});

describe("an unlisted page", () => {
  const unlisted = DOC_PAGES.filter((page) => page.unlisted === true);

  test("is the GTK dogfood note, which cli.md still has to put on a page", () => {
    expect(unlisted.map((page) => page.slug)).toEqual(["gtk"]);
    expect(findPage("gtk")?.sections).toEqual(["Local-screenshot dogfood (GTK windows)"]);
  });

  test("is absent from the nav, the landing, the sitemap and the search index", async () => {
    const search = await buildSearchIndex();
    const sitemap = sitemapXml();
    for (const page of unlisted) {
      const href = `href="/docs/${page.slug}"`;
      const linking = [...pageHtml].filter(
        ([slug, html]) => slug !== page.slug && html.includes(href),
      );
      expect(linking.map(([slug]) => slug)).toEqual([]);
      expect(indexHtml).not.toContain(href);
      expect(indexHtml).not.toContain(page.title);
      expect(sitemap).not.toContain(`/docs/${page.slug}<`);
      expect(search.filter((entry) => entry.url.startsWith(`/docs/${page.slug}`))).toEqual([]);
      expect(search.filter((entry) => entry.page === page.title)).toEqual([]);
    }
  });

  test("is no page's previous or next, and has none of its own", () => {
    for (const page of unlisted) {
      const html = pageHtml.get(page.slug) ?? "";
      expect(neighbours(page.slug)).toEqual({});
      expect(html).not.toContain('data-testid="docs-prev"');
      expect(html).not.toContain('data-testid="docs-next"');
    }
    const around = LISTED_PAGES.flatMap((page) => Object.values(neighbours(page.slug)));
    expect(around.filter((page) => page.unlisted === true)).toEqual([]);
  });

  test("still renders at its URL, with the rail and nothing marked current", () => {
    for (const page of unlisted) {
      const html = pageHtml.get(page.slug) ?? "";
      expect(html).toContain(page.title);
      expect(html).toContain('data-testid="docs-nav"');
      // The breadcrumb marks its last crumb on every page; a listed page also has its rail entry marked.
      const marked = (slug: string): number =>
        pageHtml.get(slug)?.match(/aria-current="page"/g)?.length ?? 0;
      expect(marked(page.slug)).toBe(marked("install") - 1);
      expect(html).not.toContain("noindex");
    }
  });

  test("owns no command in the command index, so nothing links to it from there", () => {
    const owners = buildCommandIndex(CLI_SPLIT.pages).map((entry) => entry.page);
    for (const page of unlisted) expect(owners).not.toContain(page.slug);
  });
});
