import readme from "../../../../README.md?raw";
import security from "../../../../SECURITY.md?raw";
import gettingStarted from "../../../../docs/getting-started.md?raw";
import metrics from "../../../../docs/metrics.md?raw";
import selfHost from "../../../web/SELF-HOST.md?raw";
import { CLI_SPLIT } from "./cli-pages.ts";
import { plainText } from "./doc-text.ts";
import { DOC_PAGES, findPage } from "./docs-map.ts";
import { type Doc, type Heading, parseDoc } from "./markdown.tsx";

/*
 * The repo's own documents, read at build time. A page renders what the file says today; it never
 * keeps a copy of its own, so the site cannot drift from the docs.
 */
export const SELF_HOST_DOC = parseDoc(selfHost, "apps/web/SELF-HOST.md");
export const SECURITY_DOC = parseDoc(security, "SECURITY.md");

function headingsOf(tokens: Doc["tokens"]): Heading[] {
  return tokens.flatMap((token) => {
    if (token.type !== "heading") return [];
    return [
      { depth: token.depth, text: plainText(token.tokens), id: CLI_SPLIT.ids.get(token) ?? "" },
    ];
  });
}

/** A cut of docs/cli.md as a document: its blocks keep the anchors GitHub gives them in the whole file. */
function cliDoc(tokens: Doc["tokens"], title: string, page?: string): Doc {
  return {
    source: "docs/cli.md",
    title,
    tokens,
    headings: headingsOf(tokens),
    ids: CLI_SPLIT.ids,
    ...(page === undefined ? {} : { page }),
  };
}

/** What docs/cli.md says before its first section: the index page leads with it. */
export const CLI_INTRO_DOC = cliDoc(CLI_SPLIT.preamble, CLI_SPLIT.title);

/** The docs pages that are a repo file of their own, by the file. */
const FILE_DOCS = {
  "docs/getting-started.md": parseDoc(gettingStarted, "docs/getting-started.md", "getting-started"),
  "docs/metrics.md": parseDoc(metrics, "docs/metrics.md", "metrics"),
};

/** The document a docs page shows: a cut of cli.md, or the page's own file. */
export function docOf(slug: string): Doc {
  const page = findPage(slug);
  if (page === undefined) throw new Error(`docs: no page ${slug}`);
  if (page.file !== undefined) return FILE_DOCS[page.file];
  const tokens = CLI_SPLIT.pages.get(slug);
  if (tokens === undefined) throw new Error(`docs: page ${slug} has no sections`);
  return cliDoc(tokens, page.title, slug);
}

/** Every docs page's document, in nav order. */
export const DOC_PAGE_DOCS: ReadonlyMap<string, Doc> = new Map(
  DOC_PAGES.map((page) => [page.slug, docOf(page.slug)]),
);

/** The README's trademark sentence, verbatim (line breaks folded), for the footer. */
export function trademarkLine(markdown: string): string {
  const match = /PixelSlash is a name of[^.]*;[^.]*\./.exec(markdown.replace(/\s+/g, " "));
  if (!match) throw new Error("README.md no longer carries the trademark line the footer shows");
  return match[0];
}

export const TRADEMARK = trademarkLine(readme);
