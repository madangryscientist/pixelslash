import { type MarkedToken, type Token, type Tokens, lexer } from "marked";
import cli from "../../../../docs/cli.md?raw";
import { marked, plainText, slugger } from "./doc-text.ts";
import { DOC_PAGES, type DocPageDef } from "./docs-map.ts";

/*
 * docs/cli.md cut into the pages of docs-map.ts. Pure: the tokens of the file go in, each page's
 * tokens come out, and nothing is copied or edited on the way, so the pages cannot drift from the
 * file. A heading the map does not place, or places twice, stops the build.
 */

export type CliSplit = {
  /** The file's own `# title`. */
  title: string;
  /** What sits between the title and the first H2. */
  preamble: MarkedToken[];
  /** Page slug → its blocks, in file order. */
  pages: Map<string, MarkedToken[]>;
  /** Heading → its GitHub anchor, for every heading after the title. */
  ids: WeakMap<Token, string>;
  /** GitHub anchor → the slug of the page that shows that heading. */
  anchorPage: Map<string, string>;
};

function claims(pages: readonly DocPageDef[]): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const page of pages) {
    for (const section of page.sections) {
      const other = claimed.get(section);
      if (other !== undefined) {
        throw new Error(`docs-map: "${section}" is on both ${other} and ${page.slug}`);
      }
      claimed.set(section, page.slug);
    }
  }
  return claimed;
}

/** The walk down the file: who owns the blocks that follow, and what each heading came to. */
type Walk = {
  claimed: ReadonlyMap<string, string>;
  used: Set<string>;
  slug: ReturnType<typeof slugger>;
  ids: WeakMap<Token, string>;
  anchorPage: Map<string, string>;
  /** The page of the last H2. */
  h2?: string | undefined;
  /** The page of the last H2, or of an H3 cut out of it. */
  current?: string | undefined;
};

function moveOwner(walk: Walk, depth: number, text: string): void {
  const mine = walk.claimed.get(text);
  if (mine !== undefined) walk.used.add(text);
  if (depth === 2) {
    if (mine === undefined) throw new Error(`docs-map: the H2 "${text}" of cli.md is on no page`);
    walk.h2 = walk.current = mine;
  } else {
    walk.current = mine ?? walk.h2;
  }
}

function visitHeading(walk: Walk, token: Tokens.Heading): void {
  const text = plainText(token.tokens);
  if (token.depth === 2 || token.depth === 3) moveOwner(walk, token.depth, text);
  const id = walk.slug(text);
  walk.ids.set(token, id);
  if (walk.current !== undefined) walk.anchorPage.set(id, walk.current);
}

/** The file's `# title` and the blocks after it. */
function takeTitle(all: MarkedToken[]): { title: string; tokens: MarkedToken[] } {
  const first = all.find((token) => token.type !== "space");
  if (first?.type !== "heading" || first.depth !== 1) return { title: "", tokens: all };
  return { title: plainText(first.tokens), tokens: all.filter((token) => token !== first) };
}

export function splitCli(markdown: string, pages: readonly DocPageDef[] = DOC_PAGES): CliSplit {
  const { title, tokens } = takeTitle(marked(lexer(markdown)));
  const walk: Walk = {
    claimed: claims(pages),
    used: new Set(),
    slug: slugger(),
    ids: new WeakMap(),
    anchorPage: new Map(),
  };
  const preamble: MarkedToken[] = [];
  const out = new Map<string, MarkedToken[]>(
    pages.filter((page) => page.file === undefined).map((page) => [page.slug, []]),
  );

  for (const token of tokens) {
    if (token.type === "heading") visitHeading(walk, token);
    const into = walk.current === undefined ? preamble : out.get(walk.current);
    into?.push(token);
  }

  for (const section of walk.claimed.keys()) {
    if (!walk.used.has(section)) throw new Error(`docs-map: cli.md has no heading "${section}"`);
  }
  return { title, preamble, pages: out, ids: walk.ids, anchorPage: walk.anchorPage };
}

export const CLI_SPLIT = splitCli(cli);
