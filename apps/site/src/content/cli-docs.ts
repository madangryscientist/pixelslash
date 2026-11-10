import { CLI_SPLIT } from "./cli-split.ts";
import { commandIndexMarkdown } from "./cli-index.ts";
import { plainText } from "./doc-text.ts";
import type { DocPageDef } from "./docs-map.ts";
import { type Doc, type Heading, parseDoc } from "./markdown.tsx";

/*
 * The docs pages cut from docs/cli.md, and the command index made from it. One chunk for all of
 * them, loaded only by those pages.
 */

function headingsOf(tokens: Doc["tokens"]): Heading[] {
  return tokens.flatMap((token) => {
    if (token.type !== "heading") return [];
    return [
      { depth: token.depth, text: plainText(token.tokens), id: CLI_SPLIT.ids.get(token) ?? "" },
    ];
  });
}

/** A cli page's document: its blocks keep the anchors GitHub gives them in the whole file. */
export function cliDocOf(page: DocPageDef): Doc {
  if (page.kind === "cli-index") return parseDoc(commandIndexMarkdown(), "docs/cli.md", page.slug);
  const tokens = CLI_SPLIT.pages.get(page.slug);
  if (tokens === undefined) throw new Error(`docs: page ${page.slug} has no sections`);
  return {
    source: "docs/cli.md",
    title: page.title,
    tokens,
    headings: headingsOf(tokens),
    ids: CLI_SPLIT.ids,
    page: page.slug,
  };
}
