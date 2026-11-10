import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { buildCommandIndex, commandIndexMarkdown } from "./src/content/cli-index.ts";
import { type CliSplit, splitCli } from "./src/content/cli-pages.ts";
import { stripTicketIds } from "./src/content/doc-text.ts";
import { DOC_PAGES } from "./src/content/docs-map.ts";

/*
 * docs/cli.md, cut up at build time so no page ships or lexes the whole 170 KB file in the browser
 * (PS-357). `virtual:cli-meta` is what every docs page needs from it: which page holds each heading,
 * and the lead the docs index shows. `virtual:cli-pages` loads one cli page's own slice: its
 * markdown, and the anchors its headings have in the whole file.
 */

const META = "virtual:cli-meta";
const PAGES = "virtual:cli-pages";
const PAGE = "virtual:cli-page/";
const CLI_MD = fileURLToPath(new URL("../../docs/cli.md", import.meta.url));

/** The docs pages cut from cli.md, the command index among them. */
const CLI_SLUGS = DOC_PAGES.filter((page) => page.file === undefined).map((page) => page.slug);

const exports = (values: Record<string, unknown>): string =>
  Object.entries(values)
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join("\n");

function metaModule(split: CliSplit): string {
  return exports({
    ANCHOR_PAGE: Object.fromEntries(split.anchorPage),
    CLI_INTRO: `# ${split.title}\n\n${split.preamble.map((token) => token.raw).join("")}`,
  });
}

function pagesModule(): string {
  const loaders = CLI_SLUGS.map(
    (slug) => `  ${JSON.stringify(slug)}: () => import(${JSON.stringify(PAGE + slug)}),`,
  );
  return `export const CLI_PAGES = {\n${loaders.join("\n")}\n};`;
}

function pageModule(split: CliSplit, slug: string): string {
  if (DOC_PAGES.find((page) => page.slug === slug)?.kind === "cli-index") {
    return exports({ MARKDOWN: commandIndexMarkdown(buildCommandIndex(split.pages)), IDS: [] });
  }
  const tokens = split.pages.get(slug);
  if (tokens === undefined) throw new Error(`cli-meta: no cli page ${slug}`);
  return exports({
    MARKDOWN: tokens.map((token) => token.raw).join(""),
    IDS: tokens.flatMap((token) => (token.type === "heading" ? [split.ids.get(token) ?? ""] : [])),
  });
}

export function cliMeta(): Plugin {
  let cached: { text: string; split: CliSplit } | undefined;
  const splitNow = (): CliSplit => {
    const text = readFileSync(CLI_MD, "utf8");
    if (cached?.text !== text) cached = { text, split: splitCli(stripTicketIds(text)) };
    return cached.split;
  };
  return {
    name: "pixelslash-cli-meta",
    resolveId: (id) => (id === META || id === PAGES || id.startsWith(PAGE) ? `\0${id}` : undefined),
    load(id) {
      if (!id.startsWith("\0virtual:cli-")) return undefined;
      this.addWatchFile(CLI_MD);
      const name = id.slice(1);
      if (name === META) return metaModule(splitNow());
      if (name === PAGES) return pagesModule();
      return pageModule(splitNow(), name.slice(PAGE.length));
    },
  };
}
