import type { MarkedToken } from "marked";
import { loadDoc } from "./docs.ts";
import { SELF_HOST_DOC } from "./repo-docs.ts";
import { EXTRA_NAV, LISTED_PAGES } from "./docs-map.ts";
import type { Doc } from "./markdown.tsx";
import type { SearchEntry } from "./search.ts";

/*
 * The index behind the docs search: every page of the docs, and the self-host guide, cut at its
 * H2 and H3 headings into entries. Built from the same parsed documents the pages render, so it
 * cannot hold a page the site does not have.
 */

/** Real HTML in the docs; a placeholder such as `<n>` in an error message is text and stays. */
const HTML_TAG =
  /<\/?(?:br|details|summary|p|div|span|a|kbd|sup|sub|img|table|tr|td|th|code)\b[^>]*>/g;

/** A block's text without its markdown syntax; code is kept as written. */
function textOf(token: MarkedToken): string {
  if (token.type === "code") return token.text;
  if (token.type === "space" || token.type === "hr") return "";
  return token.raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[`*|#]/g, "")
    .replace(/^\s*[-:]{3,}.*$/gm, "")
    .replace(HTML_TAG, "");
}

function plain(token: MarkedToken & { type: "heading" }): string {
  return token.text.replace(/[`*]/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
}

export function entriesOf(doc: Doc, base: string, pageTitle: string): SearchEntry[] {
  const out: SearchEntry[] = [];
  let current: { url: string; heading: string; parts: string[] } = {
    url: base,
    heading: pageTitle,
    parts: [],
  };
  const close = (): void => {
    const text = current.parts
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
    if (text !== "" || current.heading !== pageTitle) {
      out.push({ url: current.url, page: pageTitle, heading: current.heading, text });
    }
  };
  for (const token of doc.tokens) {
    if (token.type === "heading" && (token.depth === 2 || token.depth === 3)) {
      close();
      const id = doc.ids.get(token) ?? "";
      current = { url: id === "" ? base : `${base}#${id}`, heading: plain(token), parts: [] };
    } else {
      current.parts.push(textOf(token));
    }
  }
  close();
  return out;
}

/** Every entry: the docs pages in nav order, then the pages outside the map that the rail links. */
export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const docs = await Promise.all(
    LISTED_PAGES.map(async (page) =>
      entriesOf(await loadDoc(page.slug), `/docs/${page.slug}`, page.title),
    ),
  );
  const extra = EXTRA_NAV.flatMap((item) =>
    item.href === "/self-host"
      ? entriesOf(SELF_HOST_DOC, item.href, "Self-host the review app")
      : [],
  );
  return [...docs.flat(), ...extra];
}
