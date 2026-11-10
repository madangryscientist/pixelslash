import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Token, lexer } from "marked";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DocPage, DocsIndexPage } from "#/components/pages/docs";
import { HomePage } from "#/components/pages/home";
import { HowItWorksPage } from "#/components/pages/how-it-works";
import { splitCli } from "./cli-pages.ts";
import { CLI_SPLIT } from "./cli-split.ts";
import { OLD_ANCHOR_SCRIPT } from "./old-anchors.ts";
import { ANCHOR_PAGE } from "virtual:cli-meta";
import { CLI_INTRO_DOC } from "./cli-intro.ts";
import { loadAllDocs } from "./docs.ts";
import { SECURITY_DOC } from "./repo-docs.ts";
import { TRADEMARK } from "./trademark.ts";
import { DOC_PAGES, GROUPS, type DocPageDef, neighbours } from "./docs-map.ts";
import { resolveImageSrc } from "./resolve-links.ts";
import { plainText, slugger } from "./markdown.tsx";

/*
 * The docs against docs/cli.md as it is on disk. The file is one document, the site cuts it into
 * pages: every heading and every code block of the file must be on exactly one page, with the
 * anchor GitHub gives it, and every H2 must be placed by the map. A heading or block a page drops,
 * or shows twice, fails here.
 */
const ROOT = join(import.meta.dirname, "../../../..");
const CLI_MD = readFileSync(join(ROOT, "docs/cli.md"), "utf8");
const tokens = lexer(CLI_MD);

function codeBlocks(list: Token[]): string[] {
  return list.flatMap((token) => {
    const own = token.type === "code" && "text" in token ? [token.text] : [];
    const items = "items" in token && Array.isArray(token.items) ? codeBlocks(token.items) : [];
    const inner = "tokens" in token && Array.isArray(token.tokens) ? codeBlocks(token.tokens) : [];
    return [...own, ...items, ...inner];
  });
}

const raws = (list: readonly Token[]): string => JSON.stringify(list.map((token) => token.raw));

const unescape = (html: string): string =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

const cliPages = DOC_PAGES.filter((page) => page.file === undefined && page.kind === undefined);
// The pages render at once only once their documents are loaded, as the route loader does first.
const DOC_PAGE_DOCS = await loadAllDocs();
const pageHtml = new Map(
  DOC_PAGES.map((page) => [page.slug, renderToStaticMarkup(<DocPage slug={page.slug} />)]),
);
const indexHtml = renderToStaticMarkup(<DocsIndexPage />);
/** Every part of cli.md as the site shows it: the index lead and each cli page's body. */
const bodies = [indexHtml, ...cliPages.map((page) => pageHtml.get(page.slug) ?? "")];

/** The `id="…"` of every heading in a page's body, which is where an anchor lands. */
const idsIn = (html: string): string[] =>
  [...html.matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map((m) => m[1] ?? "");

describe("the docs map", () => {
  test("puts every H2 of cli.md on exactly one page", () => {
    const h2 = tokens.flatMap((token) =>
      token.type === "heading" && token.depth === 2 ? [plainText(token.tokens)] : [],
    );
    expect(h2.length).toBeGreaterThan(0);
    for (const text of h2) {
      const owners = cliPages.filter((page) => page.sections.includes(text));
      expect(
        owners.map((page) => page.slug),
        `"${text}"`,
      ).toHaveLength(1);
    }
  });

  test("has at least six pages, each in a group", () => {
    expect(DOC_PAGES.length).toBeGreaterThanOrEqual(6);
    for (const page of DOC_PAGES) expect(GROUPS.map((group) => group.id)).toContain(page.group);
    expect(new Set(DOC_PAGES.map((page) => page.slug)).size).toBe(DOC_PAGES.length);
  });

  test("stops the build on an H2 no page claims", () => {
    expect(() => splitCli("# T\n\n## Placed\n\n## Stray\n", [def("a", ["Placed"])])).toThrow(
      /"Stray" of cli\.md is on no page/,
    );
  });

  test("stops the build on a section on two pages", () => {
    expect(() => splitCli("# T\n\n## One\n", [def("a", ["One"]), def("b", ["One"])])).toThrow(
      /"One" is on both a and b/,
    );
  });

  test("stops the build on a listed heading that no longer exists", () => {
    expect(() => splitCli("# T\n\n## One\n", [def("a", ["One", "Gone"])])).toThrow(
      /no heading "Gone"/,
    );
  });

  test("cuts an H3 out of its H2 and puts the rest back after it", () => {
    const md = "# T\n\n## A\n\na1\n\n### Cut\n\ncut\n\n### Kept\n\nkept\n";
    const split = splitCli(md, [def("a", ["A"]), def("b", ["Cut"])]);
    const text = (slug: string): string =>
      (split.pages.get(slug) ?? []).map((token) => plainText([token])).join("|");
    expect(text("b")).toContain("Cut");
    expect(text("a")).toContain("Kept");
    expect(text("a")).not.toContain("Cut");
    expect(split.anchorPage.get("cut")).toBe("b");
    expect(split.anchorPage.get("kept")).toBe("a");
  });
});

describe("the docs pages", () => {
  test("every H2 and H3 of cli.md is on exactly one page, with its GitHub anchor", () => {
    const slug = slugger();
    const headings = tokens.filter(
      (token) => token.type === "heading" && token.depth >= 2 && token.depth <= 3,
    );
    expect(headings.length).toBeGreaterThan(0);
    const seen = bodies.flatMap(idsIn);
    for (const heading of headings) {
      if (heading.type !== "heading") continue;
      const id = slug(plainText(heading.tokens));
      expect(
        seen.filter((seenId) => seenId === id),
        `#${id}`,
      ).toHaveLength(1);
    }
  });

  test("every code block of cli.md is on exactly one page, verbatim", () => {
    const blocks = codeBlocks(tokens);
    expect(blocks.length).toBeGreaterThan(0);
    const shown = bodies.reduce((count, html) => count + (html.match(/<pre/g)?.length ?? 0), 0);
    expect(shown).toBe(blocks.length);
    const flat = unescape(bodies.join("").replace(/<[^>]+>/g, "")).replace(/\s+/g, "");
    for (const block of blocks) expect(flat).toContain(block.replace(/\s+/g, ""));
  });

  test("heading ids on one page are unique, and across pages too", () => {
    const all = bodies.flatMap(idsIn);
    expect(new Set(all).size).toBe(all.length);
  });

  test("the index shows the file's own title and the blurb before its first section", () => {
    expect(CLI_INTRO_DOC.title).toBe(CLI_SPLIT.title);
    expect(CLI_SPLIT.title).toBe("PixelSlash");
    expect(indexHtml).toContain("compares two versions of a page");
    expect(indexHtml).not.toContain("Local mlx");
  });

  test("the index lists every page, once, under its group", () => {
    // The rail links every page too, so count only the group cards.
    const cards = indexHtml.slice(indexHtml.indexOf('data-testid="docs-index"'));
    const counts = DOC_PAGES.map((item) => [
      item.slug,
      cards.match(new RegExp(`href="/docs/${item.slug}"`, "g"))?.length ?? 0,
    ]);
    expect(counts.filter(([, count]) => count !== 1)).toEqual([]);
    for (const group of GROUPS) expect(indexHtml).toContain(group.title);
  });

  test.each(DOC_PAGES.map((p) => p.slug))(
    "%s has the group nav, a rail and previous/next",
    (slug) => {
      const html = pageHtml.get(slug) ?? "";
      expect(html).toContain('data-testid="docs-nav"');
      for (const other of DOC_PAGES) expect(html).toContain(`href="/docs/${other.slug}"`);
      expect(
        html.match(/aria-current="page"/g)?.length,
        "current page marked",
      ).toBeGreaterThanOrEqual(1);
      expect(html).toContain("On this page");
      const { prev, next } = neighbours(slug);
      expect(html.includes('data-testid="docs-prev"')).toBe(prev !== undefined);
      expect(html.includes('data-testid="docs-next"')).toBe(next !== undefined);
      expect(prev !== undefined || next !== undefined).toBe(true);
    },
  );

  test("the first page has no previous and the last no next", () => {
    expect(neighbours(DOC_PAGES[0]?.slug ?? "").prev).toBeUndefined();
    expect(neighbours(DOC_PAGES.at(-1)?.slug ?? "").next).toBeUndefined();
  });

  test("getting started is docs/getting-started.md, and its links resolve", () => {
    const md = readFileSync(join(ROOT, "docs/getting-started.md"), "utf8");
    const doc = DOC_PAGE_DOCS.get("getting-started");
    expect(doc?.title).toBe("Getting started");
    expect(md).toContain("npm i -D @hackcove/pixelslash");
    expect(md).toContain("pixelslash install-browser");
    const html = pageHtml.get("getting-started") ?? "";
    expect(html).not.toContain('href="cli.md');
    for (const match of html.matchAll(/href="\/docs\/([^"#]+)#([^"]+)"/g)) {
      expect(DOC_PAGES.map((p) => p.slug)).toContain(match[1]);
      expect(CLI_SPLIT.anchorPage.get(match[2] ?? "")).toBe(match[1]);
    }
  });
});

describe("the screenshots in the docs", () => {
  const images = DOC_PAGES.flatMap((page) => {
    if (!page.file) return [];
    const md = readFileSync(join(ROOT, page.file), "utf8");
    return [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => ({
      page,
      file: page.file ?? "",
      src: match[1] ?? "",
    }));
  });

  test("every one is a file the site serves, drawn on its page", () => {
    expect(images.length).toBeGreaterThan(0);
    for (const { page, file, src } of images) {
      const served = resolveImageSrc(src, file);
      expect(served).not.toBeNull();
      expect(existsSync(join(ROOT, "apps/site/public", served ?? ""))).toBe(true);
      expect(pageHtml.get(page.slug)).toContain(`src="${served}"`);
    }
  });
});

describe("heading text", () => {
  test("is decoded, so an apostrophe is not an entity in the rail or the anchor", () => {
    const heading = SECURITY_DOC.headings.find((item) =>
      item.text.startsWith("Hardening a stranger"),
    );
    expect(heading?.text).toContain("stranger's");
    expect(heading?.id).toMatch(/^hardening-a-strangers-deployment/);
    for (const doc of [...DOC_PAGE_DOCS.values(), SECURITY_DOC]) {
      for (const item of doc.headings) expect(item.text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
    }
  });
});

describe("links into the docs", () => {
  test("every /docs/<page>#anchor on home and how it works lands on the page that holds it", () => {
    const html = renderToStaticMarkup(<HomePage />) + renderToStaticMarkup(<HowItWorksPage />);
    const links = [...html.matchAll(/href="\/docs\/([^"#]+)(?:#([^"]+))?"/g)];
    expect(links.length).toBeGreaterThan(0);
    const slugs = DOC_PAGES.map((p) => p.slug);
    const unknown = links.filter(([, slug]) => !slugs.includes(slug ?? ""));
    expect(unknown.map((link) => link[0])).toEqual([]);
    const misplaced = links.filter(
      ([, slug, anchor]) => anchor !== undefined && CLI_SPLIT.anchorPage.get(anchor) !== slug,
    );
    expect(misplaced.map((link) => link[0])).toEqual([]);
  });

  test("an old /docs#anchor is sent to the page that holds it, for every heading of cli.md", () => {
    const html = renderToStaticMarkup(<HomePage />) + renderToStaticMarkup(<HowItWorksPage />);
    expect(html).not.toMatch(/href="\/docs#/);
    for (const [anchor, slug] of CLI_SPLIT.anchorPage) {
      expect(OLD_ANCHOR_SCRIPT).toContain(`"${anchor}":"${slug}"`);
    }
    expect(CLI_SPLIT.anchorPage.get("uploading-to-a-server")).toBe("upload");
    expect(CLI_SPLIT.anchorPage.get("comparing-two-snapshot-dirs")).toBe("compare-dirs");
    expect(CLI_SPLIT.anchorPage.get("snapshot-capture-the-pinned-image")).toBe("capture");
    expect(CLI_SPLIT.anchorPage.get("exit-codes-and-the-failed-line")).toBe("signing-in");
  });

  test("the build-time anchor map and index lead are the split of cli.md, unchanged", () => {
    expect(ANCHOR_PAGE).toEqual(Object.fromEntries(CLI_SPLIT.anchorPage));
    expect(raws(CLI_INTRO_DOC.tokens)).toBe(raws(CLI_SPLIT.preamble));
  });
});

describe("the troubleshooting page", () => {
  const md = readFileSync(join(ROOT, "docs/help/troubleshooting.md"), "utf8");
  const headings = [...md.matchAll(/^## (.+)$/gm)]
    .map((match) => (match[1] ?? "").replaceAll("`", ""))
    .filter((heading) => heading !== "Next");

  /*
   * A heading is checked piece by piece: every literal piece between its `<…>` values must occur
   * in a source file. Renaming a variable the message interpolates cannot fail this, and a message
   * that genuinely changed still does. A few messages are composed (`config: <where> <what>`, the
   * tags joined into one sentence), so the piece the file owns is named instead of the heading.
   * The search covers the app's own messages too: a 426 or `rebaseline_needed` is the server's to
   * say and the CLI relays it.
   */
  const COMPOSED: Readonly<Record<string, readonly string[]>> = {
    "--threshold must be a number from 0 to 1": ["must be a number from 0 to 1"],
    "config: stabilise.timers needs a clock to pause: set stabilise.clock, or timers: false": [
      "needs a clock to pause: set stabilise.clock, or timers: false",
    ],
    'warning: mask "<selector>" matched no shot in this run': [
      '"${selector}" matched no shot in this run',
    ],
    'storybook: story "<id>" tag "<tag>" must be pixelslash-flaky-review or pixelslash-flaky-skip':
      ['storybook: story "${story.id}" tag "${unknown}" must be'],
    'storybook: story "<id>" has both pixelslash-flaky-review or pixelslash-flaky-skip': [
      'storybook: story "${story.id}" has both',
    ],
  };

  /** The pieces of a heading that must be found: its literals, or a composed message's own part. */
  function pieces(heading: string): string[] {
    const composed = COMPOSED[heading];
    if (composed !== undefined) return [...composed];
    return heading
      .split(/<[^>]+>/)
      .map((piece) => piece.trim())
      .filter((piece) => piece.length >= 6);
  }

  test("every entry is a message the code still writes", () => {
    expect(headings.length).toBeGreaterThan(10);
    expect(new Set(headings).size).toBe(headings.length);
    const sources = messageSources();
    const missing = headings.flatMap((heading) =>
      pieces(heading)
        .filter((piece) => !sources.some((source) => source.includes(piece)))
        .map((piece) => `${heading} -> ${piece}`),
    );
    expect(missing).toEqual([]);
  });
});

/** Every `.ts`/`.tsx` under each package's `src` and `apps/web/src`, as text: what can print a message. */
function messageSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
      return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
        ? [readFileSync(path, "utf8")]
        : [];
    });
  const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, "packages", entry.name, "src"))
    .filter((dir) => existsSync(dir));
  return [...packages.flatMap(walk), ...walk(join(ROOT, "apps/web/src"))];
}

describe("the footer's trademark line", () => {
  test("is the README's sentence", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain(TRADEMARK);
    expect(TRADEMARK).toMatch(/^PixelSlash is a name of .*; .*\.$/);
  });
});

function def(slug: string, sections: string[]): DocPageDef {
  return { slug, title: slug, group: "reference", sections };
}
