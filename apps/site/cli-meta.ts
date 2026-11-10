import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { lexer } from "marked";
import { splitCli } from "./src/content/cli-pages.ts";
import { stripTicketIds } from "./src/content/doc-text.ts";

/*
 * What every docs page needs from docs/cli.md without the file itself: which page holds each of its
 * headings, and the lead before its first section. Worked out here at build time, so a page that
 * links into cli.md, or the docs index that leads with its blurb, does not ship and lex 170 KB of
 * markdown in the browser to get them (PS-357).
 */

const ID = "virtual:cli-meta";
const RESOLVED = `\0${ID}`;
const CLI_MD = fileURLToPath(new URL("../../docs/cli.md", import.meta.url));

/** The module's source: the anchor map and the intro, from cli.md as it is on disk now. */
export function cliMetaModule(markdown: string): string {
  const text = stripTicketIds(markdown);
  const split = splitCli(text);
  const tokens = lexer(text);
  const end = tokens.findIndex((token) => token.type === "heading" && token.depth === 2);
  const intro = (end === -1 ? tokens : tokens.slice(0, end)).map((token) => token.raw).join("");
  return [
    `export const ANCHOR_PAGE = ${JSON.stringify(Object.fromEntries(split.anchorPage))};`,
    `export const CLI_INTRO = ${JSON.stringify(intro)};`,
  ].join("\n");
}

export function cliMeta(): Plugin {
  return {
    name: "pixelslash-cli-meta",
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      this.addWatchFile(CLI_MD);
      return cliMetaModule(readFileSync(CLI_MD, "utf8"));
    },
  };
}
