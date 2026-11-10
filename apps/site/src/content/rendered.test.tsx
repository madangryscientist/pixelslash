import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DocPage, DocsIndexPage } from "#/components/pages/docs";
import { HomePage } from "#/components/pages/home";
import { HowItWorksPage } from "#/components/pages/how-it-works";
import { SecurityPage } from "#/components/pages/security";
import { SelfHostPage } from "#/components/pages/self-host";
import { TICKET_ID } from "./doc-text.ts";
import { loadAllDocs } from "./docs.ts";
import { DOC_PAGES, EXTRA_NAV, GROUPS, neighbours } from "./docs-map.ts";
import { CLI_SPLIT } from "./cli-split.ts";

const ROOT = join(import.meta.dirname, "../../../..");
// The pages render at once only once their documents are loaded, as the route loader does first.
await loadAllDocs();
const html = new Map(
  DOC_PAGES.map((page) => [page.slug, renderToStaticMarkup(<DocPage slug={page.slug} />)]),
);
const text = (markup: string): string => markup.replace(/<[^>]+>/g, " ");

/** The first column of the exit-code table that follows `heading`. */
function codeRows(markdown: string, heading: string): string[] {
  return markdown
    .slice(markdown.indexOf(heading))
    .split("\n")
    .filter((line) => /^\| \d \|/.test(line))
    .map((line) => line.split("|")[1]?.trim() ?? "");
}

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

describe("no private ticket id in a rendered page", () => {
  test("not in any docs page, the docs index, self-host, security or the home page", () => {
    const pages: [string, string][] = [
      ...[...html].map(([slug, markup]): [string, string] => [`/docs/${slug}`, markup]),
      ["/docs", renderToStaticMarkup(<DocsIndexPage />)],
      ["/self-host", renderToStaticMarkup(<SelfHostPage />)],
      ["/security", renderToStaticMarkup(<SecurityPage />)],
      ["/how-it-works", renderToStaticMarkup(<HowItWorksPage />)],
      ["/", renderToStaticMarkup(<HomePage />)],
    ];
    const leaking = pages
      .filter(([, markup]) => TICKET_ID.test(text(markup)))
      .map(([path]) => path);
    expect(leaking).toEqual([]);
  });
});

describe("exit codes", () => {
  test("a page that can exit non-zero links the exit codes page, and no other does", () => {
    const wrong = DOC_PAGES.filter((page) => {
      const markup = html.get(page.slug) ?? "";
      const shows = markup.includes('data-testid="docs-exits"');
      const wants = page.exits === true;
      return shows !== wants || (shows && !markup.includes('href="/docs/exit-codes"'));
    }).map((page) => page.slug);
    expect(wrong).toEqual([]);
  });

  test("the at-a-glance table lists the same codes as cli.md, one section each", () => {
    const cli = codeRows(read("docs/cli.md"), "**Exit codes.**");
    const explained = read("docs/help/exit-codes.md");
    const page = codeRows(explained, "## At a glance");
    expect(cli.length).toBeGreaterThanOrEqual(9);
    expect(page.slice(0, cli.length)).toEqual(cli);
    // A code the CLI can return is a code the page explains.
    const unexplained = cli.filter((code) => !new RegExp(`^## ${code}: `, "m").test(explained));
    expect(unexplained).toEqual([]);
  });
});

describe("the page template", () => {
  test("a page cut from cli.md opens with a sentence, then shows an example in its first blocks", () => {
    const pages = DOC_PAGES.filter((page) => page.file === undefined && page.kind === undefined);
    const shape = pages.map((page) => {
      const tokens = (CLI_SPLIT.pages.get(page.slug) ?? []).filter(
        (token) => token.type !== "space",
      );
      const types = tokens.slice(0, 8).map((token) => token.type);
      // The H2 (or the H3 a split page starts on) is followed by prose, not by a list or a table.
      return {
        slug: page.slug,
        opens: types.slice(0, 2),
        example: types.includes("code"),
      };
    });
    expect(shape.filter((s) => s.opens.join() !== "heading,paragraph")).toEqual([]);
    expect(shape.filter((s) => !s.example)).toEqual([]);
  });
});

describe("prev and next", () => {
  test("every page links the page before and after it in the map, across every group", () => {
    const wrong = DOC_PAGES.flatMap((page, index) => {
      const { prev, next } = neighbours(page.slug);
      const markup = html.get(page.slug) ?? "";
      const want = [DOC_PAGES[index - 1], DOC_PAGES[index + 1]].flatMap((p) => (p ? [p.slug] : []));
      const got = [prev, next].flatMap((p) => (p ? [p.slug] : []));
      const unlinked = got.filter((slug) => !markup.includes(`href="/docs/${slug}"`));
      return got.join() === want.join() && unlinked.length === 0 ? [] : [page.slug];
    });
    expect(wrong).toEqual([]);
  });

  test("the pages of one group are next to one another", () => {
    const broken = GROUPS.filter((group) => {
      const at = DOC_PAGES.flatMap((page, index) => (page.group === group.id ? [index] : []));
      return at.some((position, i) => i > 0 && position !== (at[i - 1] ?? -2) + 1);
    }).map((group) => group.id);
    expect(broken).toEqual([]);
  });
});

describe("the docs rail", () => {
  test("carries the search box and every page, self-host included", () => {
    const markup = html.get("install") ?? "";
    expect(markup).toContain('data-testid="docs-search"');
    expect(EXTRA_NAV.filter((item) => !markup.includes(`href="${item.href}"`))).toEqual([]);
  });

  test("the self-host page is inside the docs layout, with the rail marking it", () => {
    const markup = renderToStaticMarkup(<SelfHostPage />);
    expect(markup).toContain('data-testid="docs-nav"');
    expect(markup).toContain('data-testid="docs-edit"');
  });
});

describe("a code block can be copied, and every page can be edited", () => {
  test("every docs page links its source on GitHub", () => {
    const without = DOC_PAGES.filter((page) => !html.get(page.slug)?.includes("/edit/main/"));
    expect(without.map((page) => page.slug)).toEqual([]);
  });

  test("code blocks carry the copy button", () => {
    expect(html.get("install")).toMatch(/<button[^>]*>copy<\/button>/);
  });
});
