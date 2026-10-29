import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Token, lexer } from "marked";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { DocsPage } from "#/components/pages/docs";
import { HomePage } from "#/components/pages/home";
import { HowItWorksPage } from "#/components/pages/how-it-works";
import { CLI_DOC, SECURITY_DOC, TRADEMARK, trademarkLine } from "./docs.ts";
import { plainText, slugger } from "./markdown.tsx";

/*
 * The docs page against docs/cli.md as it is on disk: every heading and every code block of the
 * file is on the page, with the anchor GitHub gives it. A heading or block the page drops fails.
 */
const ROOT = join(import.meta.dirname, "../../../..");
const tokens = lexer(readFileSync(join(ROOT, "docs/cli.md"), "utf8"));

function codeBlocks(list: Token[]): string[] {
  return list.flatMap((token) => {
    const own = token.type === "code" && "text" in token ? [token.text] : [];
    const items = "items" in token && Array.isArray(token.items) ? codeBlocks(token.items) : [];
    const inner = "tokens" in token && Array.isArray(token.tokens) ? codeBlocks(token.tokens) : [];
    return [...own, ...items, ...inner];
  });
}

const unescape = (html: string): string =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

describe("the docs page", () => {
  const html = renderToStaticMarkup(<DocsPage />);
  const text = unescape(html.replace(/<[^>]+>/g, ""));

  test("has every heading of cli.md, with its GitHub anchor", () => {
    const slug = slugger();
    const headings = tokens.filter((token) => token.type === "heading" && token.depth > 1);
    expect(CLI_DOC.headings).toHaveLength(headings.length);
    for (const heading of headings) {
      if (heading.type !== "heading") continue;
      const id = slug(plainText(heading.tokens));
      expect(html, `#${id}`).toContain(`id="${id}"`);
      expect(html, `rail link to #${id}`).toContain(`href="#${id}"`);
    }
  });

  test("has every code block of cli.md, verbatim", () => {
    const blocks = codeBlocks(tokens);
    expect(blocks.length).toBeGreaterThan(0);
    expect(html.match(/<pre/g)).toHaveLength(blocks.length);
    const flat = text.replace(/\s+/g, "");
    for (const block of blocks) expect(flat).toContain(block.replace(/\s+/g, ""));
  });

  test("the title is cli.md's own", () => {
    const first = tokens.find((token) => token.type === "heading");
    const title = first?.type === "heading" && first.depth === 1 ? plainText(first.tokens) : "";
    expect(title).not.toBe("");
    expect(CLI_DOC.title).toBe(title);
  });
});

describe("heading text", () => {
  test("is decoded, so an apostrophe is not an entity in the rail or the anchor", () => {
    const heading = SECURITY_DOC.headings.find((item) =>
      item.text.startsWith("Hardening a stranger"),
    );
    expect(heading?.text).toContain("stranger's");
    expect(heading?.id).toMatch(/^hardening-a-strangers-deployment/);
    for (const doc of [CLI_DOC, SECURITY_DOC]) {
      for (const item of doc.headings) expect(item.text).not.toMatch(/&(amp|lt|gt|quot|#39);/);
    }
  });
});

describe("links into the docs", () => {
  test("every /docs#anchor on home and how it works is a heading of cli.md", () => {
    const ids = new Set(CLI_DOC.headings.map((heading) => heading.id));
    const html = renderToStaticMarkup(<HomePage />) + renderToStaticMarkup(<HowItWorksPage />);
    const anchors = [...html.matchAll(/href="\/docs#([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) expect([...ids]).toContain(anchor);
  });
});

describe("the footer's trademark line", () => {
  test("is the README's sentence", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\s+/g, " ");
    expect(readme).toContain(TRADEMARK);
    expect(TRADEMARK).toMatch(/^PixelSlash is a name of .*; .*\.$/);
  });

  test("stops the build when the README loses it", () => {
    expect(() => trademarkLine("# PixelSlash\n\nNo such line.")).toThrow(/trademark line/);
  });
});
